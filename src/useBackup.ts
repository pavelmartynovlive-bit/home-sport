import { useCallback, useEffect, useRef, useState } from 'react'
import { BackupError, fetchBackup, mergeHistory, normalizeBackupUrl, pendingSessions, readBackupConfig, saveBackupConfig, uploadSession } from './backup'
import type { BackupConfig } from './backup'
import { saveState } from './store'
import type { StoredState } from './types'
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
    // Authenticate before persisting a new destination or sending any workouts.
    await fetchBackup(candidate)
    running.current?.abort()
    try { saveBackupConfig(candidate) } catch { throw new BackupError('Не удалось сохранить подключение на телефоне. Проверь доступ к хранилищу.') }
    configRef.current = candidate
    setConfig(candidate)
    setStatus('Подключено. Готовим резервную копию.')
  }
  const disconnect = () => {
    saveBackupConfig(null)
    running.current?.abort()
    configRef.current = null
    setConfig(null)
    setStatus('')
  }
  const sync = useCallback(async () => {
    const current = configRef.current
    if (!current || (running.current && !running.current.signal.aborted) || !navigator.onLine) return
    const pending = pendingSessions(stateRef.current.history, current)
    if (!pending.length) return
    const controller = new AbortController()
    running.current = controller
    setBusy(true)
    setStatus('Отправляем копию…')
    try {
      for (const session of pending) {
        await uploadSession(current, session, controller.signal)
        if (configRef.current?.url !== current.url || configRef.current?.key !== current.key || controller.signal.aborted) return
        const updated = { ...configRef.current, savedIds: [...new Set([...configRef.current.savedIds, session.id])] }
        // Mark acknowledged only after the API confirms the committed database write.
        saveBackupConfig(updated)
        configRef.current = updated
        setConfig(updated)
      }
      setStatus(pendingSessions(stateRef.current.history, configRef.current!).length ? 'Ожидает отправки' : 'Копия на сервере сохранена')
    } catch (error) {
      if (!controller.signal.aborted) setStatus(error instanceof BackupError ? error.message : 'Ожидает отправки. Повторим, когда приложение будет открыто и появится связь.')
    } finally {
      if (running.current === controller) { running.current = null; setBusy(false) }
    }
  }, [])
  const restore = async () => {
    if (running.current || !configRef.current) throw new BackupError('Дождись завершения отправки.')
    const current = configRef.current
    const controller = new AbortController()
    running.current = controller
    setBusy(true)
    try {
      const remote = await fetchBackup(current, controller.signal)
      if (controller.signal.aborted || configRef.current?.url !== current.url || configRef.current?.key !== current.key) return 0
      const latest = stateRef.current
      const merged = mergeHistory(latest.history, remote)
      const added = merged.length - latest.history.length
      const updatedState = { ...latest, history: merged }
      if (!saveState(updatedState)) throw new BackupError('Не удалось сохранить восстановленные тренировки на телефоне.')
      stateRef.current = updatedState
      setState(updatedState)
      // Colliding local IDs are deliberately left pending; the server will detect conflicts.
      const restored = remote.filter(s => !latest.history.some(local => local.id === s.id)).map(s => s.id)
      const updatedConfig = { ...current, savedIds: [...new Set([...current.savedIds, ...restored])] }
      saveBackupConfig(updatedConfig)
      configRef.current = updatedConfig
      setConfig(updatedConfig)
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
  const displayedStatus = pending && !busy && (!status || status === 'Копия на сервере сохранена') ? 'Ожидает отправки' : status
  return { config, busy, pending, status: config ? displayedStatus || (pending ? 'Ожидает отправки' : 'Копия на сервере сохранена') : 'Копия на сервере не подключена', connect, disconnect, sync, restore }
}
