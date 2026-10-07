import { useCallback, useEffect, useRef, useState } from 'react'
import { BackupError, confirmedSessionIds, fetchBackup, mergeHistory, normalizeBackupUrl, pendingSessions, readBackupConfig, saveBackupConfig, uploadSession } from './backup'
import type { BackupConfig } from './backup'
import { saveState } from './store'
import type { StoredState, WorkoutSession } from './types'
export function useBackup(state: StoredState, setState: (state: StoredState) => void) {
  const [config, setConfig] = useState(readBackupConfig)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const stateRef = useRef(state)
  const configRef = useRef(config)
  const running = useRef<AbortController | null>(null)
  stateRef.current = state
  configRef.current = config
  const connect = async (url: string, key: string) => {
    if (key.trim().length < 32) throw new BackupError('Проверь ключ доступа: нужно не меньше 32 символов.')
    const candidate: BackupConfig = { url: normalizeBackupUrl(url), key: key.trim(), savedIds: [] }
    await fetchBackup(candidate)
    running.current?.abort()
    try { saveBackupConfig(candidate) } catch { throw new BackupError('Не удалось сохранить подключение на телефоне. Проверь доступ к хранилищу.') }
    configRef.current = candidate
    setConfig(candidate)
    setStatus('Подключено. Проверяем историю на сервере…')
  }
  const disconnect = () => {
    saveBackupConfig(null)
    running.current?.abort()
    configRef.current = null
    setConfig(null)
    setStatus('')
  }
  const mergeRemote = useCallback((current: BackupConfig, remote: WorkoutSession[]) => {
    const latest = stateRef.current
    const merged = mergeHistory(latest.history, remote)
    const added = merged.length - latest.history.length
    if (added) {
      const updatedState = { ...latest, history: merged }
      if (!saveState(updatedState)) throw new BackupError('Не удалось сохранить восстановленные тренировки на телефоне.')
      stateRef.current = updatedState
      setState(updatedState)
    }
    // The server inventory is authoritative for acknowledgements, even after a snapshot restore.
    const updated = { ...current, savedIds: confirmedSessionIds(merged, remote) }
    saveBackupConfig(updated)
    configRef.current = updated
    setConfig(updated)
    return added
  }, [setState])
  const sync = useCallback(async () => {
    const current = configRef.current
    if (!current || (running.current && !running.current.signal.aborted)) return
    if (!navigator.onLine) { setStatus('Нет связи. Проверим копию при появлении интернета.'); return }
    const controller = new AbortController()
    running.current = controller
    setBusy(true)
    setStatus('Проверяем историю на сервере…')
    try {
      const remote = await fetchBackup(current, controller.signal)
      if (configRef.current?.url !== current.url || configRef.current?.key !== current.key || controller.signal.aborted) return
      mergeRemote(current, remote)
      const pending = pendingSessions(stateRef.current.history, configRef.current!)
      let conflict = ''
      if (pending.length) setStatus('Отправляем копию…')
      for (const session of pending) {
        try { await uploadSession(current, session, controller.signal) }
        catch (error) {
          // A conflicting record must not block backups of other workouts.
          if (error instanceof BackupError && error.status === 409) { conflict = error.message; continue }
          throw error
        }
        if (configRef.current?.url !== current.url || configRef.current?.key !== current.key || controller.signal.aborted) return
        const updated: BackupConfig = { ...configRef.current, savedIds: [...new Set([...configRef.current.savedIds, session.id])] }
        saveBackupConfig(updated)
        configRef.current = updated
        setConfig(updated)
      }
      setStatus(conflict || (pendingSessions(stateRef.current.history, configRef.current!).length ? 'Ожидает отправки' : stateRef.current.history.length ? 'Копия на сервере сохранена' : 'На сервере пока нет тренировок'))
    } catch (error) {
      if (!controller.signal.aborted) setStatus(error instanceof BackupError ? error.message : `${pendingSessions(stateRef.current.history, configRef.current || current).length ? 'Ожидает отправки. ' : ''}Не удалось проверить или отправить копию. Тренировки на телефоне сохранены. Повторим при появлении связи.`)
    } finally {
      if (running.current === controller) { running.current = null; setBusy(false) }
    }
  }, [mergeRemote])
  const restore = async () => {
    if (running.current || !configRef.current) throw new BackupError('Дождись завершения проверки или отправки.')
    const current = configRef.current
    const controller = new AbortController()
    running.current = controller
    setBusy(true)
    try {
      const remote = await fetchBackup(current, controller.signal)
      if (controller.signal.aborted || configRef.current?.url !== current.url || configRef.current?.key !== current.key) return 0
      const added = mergeRemote(current, remote)
      setStatus(`Восстановлено тренировок: ${added}`)
      return added
    } finally {
      if (running.current === controller) { running.current = null; setBusy(false) }
    }
  }
  useEffect(() => {
    const trigger = () => { if (document.visibilityState === 'visible') void sync() }
    trigger()
    window.addEventListener('online', trigger)
    document.addEventListener('visibilitychange', trigger)
    const timer = window.setInterval(trigger, 60000)
    return () => { window.removeEventListener('online', trigger); document.removeEventListener('visibilitychange', trigger); window.clearInterval(timer) }
  }, [sync, state.history, config?.url, config?.key])
  useEffect(() => () => running.current?.abort(), [])
  const pending = config ? pendingSessions(state.history, config).length : 0
  const displayedStatus = pending && !busy && status === 'Копия на сервере сохранена' ? 'Ожидает отправки' : status
  return { config, busy, pending, status: config ? displayedStatus || 'Проверяем подключение к серверу…' : 'Копия на сервере не подключена', connect, disconnect, sync, restore }
}
