import { useCallback, useEffect, useRef, useState } from 'react'
import { BackupError, canUpdateDraft, confirmedSessionIds, fetchBackup, fetchDraft, mergeHistory, normalizeBackupUrl, pendingSessions, readBackupConfig, sameSession, saveBackupConfig, uploadDraft, uploadSession } from './backup'
import type { BackupConfig } from './backup'
import { saveState, upgradeActiveSession } from './store'
import type { StoredState, WorkoutSession } from './types'
export function useBackup(state: StoredState, setState: (state: StoredState) => void) {
  const [config, setConfig] = useState(readBackupConfig)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [draftStatus, setDraftStatus] = useState('')
  const stateRef = useRef(state)
  const configRef = useRef(config)
  const running = useRef<AbortController | null>(null)
  const draftAttempt = useRef<WorkoutSession | null>(null)
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
    setDraftStatus('Проверяем текущую тренировку…')
    draftAttempt.current = null
  }
  const disconnect = () => {
    saveBackupConfig(null)
    running.current?.abort()
    configRef.current = null
    setConfig(null)
    setStatus('')
    setDraftStatus('')
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
  const syncDraft = useCallback(async (current: BackupConfig, controller: AbortController) => {
    const unchangedDestination = () => !controller.signal.aborted && configRef.current?.url === current.url && configRef.current?.key === current.key
    try {
      const remote = await fetchDraft(current, controller.signal)
      if (!unchangedDestination()) return
      let latest = stateRef.current
      // A finished session must not be resumed from a stale local or remote draft.
      if (latest.active && latest.history.some(s => s.id === latest.active!.id && s.finishedAt)) {
        const updated = { ...latest, active: null }
        if (!saveState(updated)) throw new BackupError('Не удалось сохранить состояние текущей тренировки на телефоне.')
        stateRef.current = updated; setState(updated); latest = updated
      }
      const active = latest.active
      draftAttempt.current = active
      if (!active && remote.session && !latest.history.some(s => s.id === remote.session!.id)) {
        const updated = { ...latest, active: upgradeActiveSession(remote.session) }
        if (!saveState(updated)) throw new BackupError('Не удалось восстановить текущую тренировку на телефоне.')
        stateRef.current = updated; setState(updated)
      } else if (active && !sameSession(active, remote.session)) {
        if (!canUpdateDraft(configRef.current!, remote, active)) {
          throw new BackupError('На сервере другая текущая тренировка. Копия на телефоне сохранена; серверную не перезаписываем.', 409)
        }
        setDraftStatus('Сохраняем текущую тренировку…')
        // Persist the outgoing snapshot before PUT to recover a lost acknowledgement, even after more edits.
        const outgoing = { ...configRef.current!, draftInFlight: { version: 1 as const, revision: remote.revision, session: active } }
        saveBackupConfig(outgoing); configRef.current = outgoing; setConfig(outgoing)
        const saved = await uploadDraft(current, active, remote.revision, controller.signal)
        if (!unchangedDestination()) return
        const updated = { ...configRef.current!, draft: saved, draftInFlight: undefined }
        saveBackupConfig(updated); configRef.current = updated; setConfig(updated)
        setDraftStatus(sameSession(stateRef.current.active, active) ? 'Текущая тренировка сохранена на сервере' : 'Изменения текущей тренировки ожидают отправки')
        return
      }
      const updated = { ...configRef.current!, draft: remote, draftInFlight: undefined }
      saveBackupConfig(updated); configRef.current = updated; setConfig(updated)
      setDraftStatus(stateRef.current.active ? 'Текущая тренировка сохранена на сервере' : remote.session ? 'Завершённая тренировка ожидает отправки в историю' : 'Текущей тренировки на сервере нет')
    } catch (error) {
      if (!unchangedDestination()) return
      setDraftStatus(error instanceof BackupError && error.status === 404 ? 'Для копии текущей тренировки нужно обновить сервер. Завершённые тренировки копируются как раньше.' : error instanceof BackupError ? error.message : 'Текущая тренировка сохранена на телефоне. Копию отправим при восстановлении связи.')
    }
  }, [setState])
  const sync: () => Promise<void> = useCallback(async () => {
    const current = configRef.current
    if (!current || (running.current && !running.current.signal.aborted)) return
    if (!navigator.onLine) { setStatus('Нет связи. Проверим копию при появлении интернета.'); return }
    const controller = new AbortController()
    running.current = controller
    setBusy(true)
    setStatus('Проверяем историю на сервере…')
    let queuedDuringSync = false
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
      await syncDraft(current, controller)
      if (!controller.signal.aborted && configRef.current) queuedDuringSync = pendingSessions(stateRef.current.history, configRef.current).some(s => !pending.some(p => p.id === s.id))
    } catch (error) {
      if (!controller.signal.aborted) setStatus(error instanceof BackupError ? error.message : `${pendingSessions(stateRef.current.history, configRef.current || current).length ? 'Ожидает отправки. ' : ''}Не удалось проверить или отправить копию. Тренировки на телефоне сохранены. Повторим при появлении связи.`)
    } finally {
      if (running.current === controller) {
        running.current = null; setBusy(false)
        if (queuedDuringSync) window.setTimeout(() => void sync(), 0)
      }
    }
  }, [mergeRemote, syncDraft])
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
      await syncDraft(current, controller)
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
  useEffect(() => {
    if (!config || !state.active || busy || sameSession(state.active, config.draft?.session) || sameSession(state.active, draftAttempt.current)) return
    const timer = window.setTimeout(() => {
      if (document.visibilityState === 'visible') { draftAttempt.current = stateRef.current.active; void sync() }
    }, 3000)
    return () => window.clearTimeout(timer)
  }, [state.active, config?.url, config?.key, config?.draft, busy, sync])
  useEffect(() => () => running.current?.abort(), [])
  const pending = config ? pendingSessions(state.history, config).length : 0
  const displayedStatus = pending && !busy && status === 'Копия на сервере сохранена' ? 'Ожидает отправки' : status
  const draftPending = !!(config && state.active && !sameSession(state.active, config.draft?.session))
  const displayedDraftStatus = draftPending && (!draftStatus || draftStatus === 'Текущая тренировка сохранена на сервере' || draftStatus === 'Текущей тренировки на сервере нет') ? 'Изменения текущей тренировки ожидают отправки' : draftStatus
  return { config, busy, pending, draftPending, draftStatus: config ? displayedDraftStatus || 'Проверяем текущую тренировку…' : 'Текущая тренировка сохраняется на телефоне', status: config ? displayedStatus || 'Проверяем подключение к серверу…' : 'Копия на сервере не подключена', connect, disconnect, sync, restore }
}
