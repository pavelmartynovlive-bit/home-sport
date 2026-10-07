import { isSession } from './store'
import type { WorkoutSession } from './types'
export interface DraftBackup { version: 1; revision: number; session: WorkoutSession | null }
export interface BackupConfig { url: string; key: string; savedIds: string[]; draft?: DraftBackup; draftInFlight?: DraftBackup }
export const BACKUP_KEY = 'home-sport:backup:v1'
export function normalizeBackupUrl(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new BackupError('Укажи правильный HTTPS-адрес сервера.') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) throw new BackupError('Укажи HTTPS-адрес сервера без параметров и пароля.')
  return url.href.replace(/\/+$/, '')
}
export function readBackupConfig(): BackupConfig | null {
  try {
    const c = JSON.parse(localStorage.getItem(BACKUP_KEY) || 'null')
    if (!c || typeof c.url !== 'string' || typeof c.key !== 'string' || c.key.length < 32 || !Array.isArray(c.savedIds) || !c.savedIds.every((id: unknown) => typeof id === 'string')) return null
    return { url: normalizeBackupUrl(c.url), key: c.key, savedIds: c.savedIds, ...(isDraft(c.draft) ? { draft: c.draft } : {}), ...(isDraft(c.draftInFlight) ? { draftInFlight: c.draftInFlight } : {}) }
  } catch { return null }
}
export function saveBackupConfig(config: BackupConfig | null): void {
  const serialized = config ? JSON.stringify(config) : null
  if (serialized) localStorage.setItem(BACKUP_KEY, serialized)
  else localStorage.removeItem(BACKUP_KEY)
  if (localStorage.getItem(BACKUP_KEY) !== serialized) throw new BackupError('Не удалось сохранить подключение на телефоне. Проверь доступ к хранилищу.')
}
export class BackupError extends Error { constructor(message: string, public status?: number) { super(message) } }
async function request(config: BackupConfig, path: string, options: RequestInit = {}, signal?: AbortSignal) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timeout = setTimeout(abort, 15000)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  try {
    const response = await fetch(`${config.url}${path}`, {
      ...options, cache: 'no-store', redirect: 'error', credentials: 'omit',
      headers: { Authorization: `Bearer ${config.key}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      signal: controller.signal,
    })
    if (!response.ok) throw new BackupError(response.status === 401 || response.status === 403 ? 'Сервер не принял ключ доступа.' : response.status === 409 ? 'На сервере есть другая версия этой тренировки. Данные на телефоне сохранены.' : 'Сервер временно недоступен. Повторим отправку позже.', response.status)
    return await response.json()
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }

}
export async function fetchBackup(config: BackupConfig, signal?: AbortSignal): Promise<WorkoutSession[]> {
  const data = await request(config, '/v1/sessions', {}, signal)
  if (data?.version !== 1 || !Array.isArray(data.sessions) || data.sessions.length > 10000 || !data.sessions.every((s: unknown) => isSession(s) && !!s.finishedAt)) throw new BackupError('Формат копии на сервере не подходит. Данные на телефоне не изменены.')
  if (new Set(data.sessions.map((s: WorkoutSession) => s.id)).size !== data.sessions.length) throw new BackupError('В копии обнаружены повторяющиеся записи.')
  return data.sessions
}
export async function uploadSession(config: BackupConfig, session: WorkoutSession, signal?: AbortSignal): Promise<void> {
  if (!isSession(session) || !session.finishedAt) throw new BackupError('Отправлять можно только завершённые тренировки.')
  const result = await request(config, `/v1/sessions/${encodeURIComponent(session.id)}`, { method: 'PUT', body: JSON.stringify(session) }, signal)
  if (result?.saved !== true || result.id !== session.id) throw new BackupError('Сервер не подтвердил сохранение. Повторим отправку позже.')
}
export function mergeHistory(local: WorkoutSession[], remote: WorkoutSession[]): WorkoutSession[] {
  const byId = new Map(remote.map(s => [s.id, s]))
  // Keep local values on collisions; restoration never overwrites phone results.
  local.forEach(s => byId.set(s.id, s))
  return [...byId.values()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || a.id.localeCompare(b.id))
}
export function pendingSessions(history: WorkoutSession[], config: BackupConfig) {
  const saved = new Set(config.savedIds)
  return history.filter(s => s.finishedAt && !saved.has(s.id))
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value)
}
export function sameSession(a: WorkoutSession | null | undefined, b: WorkoutSession | null | undefined): boolean {
  return canonical(a ?? null) === canonical(b ?? null)
}
export function canUpdateDraft(config: BackupConfig, remote: DraftBackup, active: WorkoutSession): boolean {
  if (!remote.session) return true
  if (remote.session.id !== active.id) return false
  const base = config.draft
  const sent = config.draftInFlight
  return sameSession(base?.session, remote.session) ||
    !!(base?.session?.id === active.id && remote.revision < base.revision) ||
    !!(sent && remote.revision > sent.revision && sameSession(sent.session, remote.session))
}
function isDraft(data: unknown): data is DraftBackup {
  if (!data || typeof data !== 'object') return false
  const d = data as DraftBackup
  return d.version === 1 && Number.isSafeInteger(d.revision) && d.revision >= 0 &&
    (d.session === null || (isSession(d.session) && d.session.finishedAt === undefined))
}
export async function fetchDraft(config: BackupConfig, signal?: AbortSignal): Promise<DraftBackup> {
  const data = await request(config, '/v1/draft', {}, signal)
  if (!isDraft(data)) throw new BackupError('Формат текущей тренировки на сервере не подходит. Данные телефона сохранены.')
  return data
}
export async function uploadDraft(config: BackupConfig, session: WorkoutSession, revision: number, signal?: AbortSignal): Promise<DraftBackup> {
  if (!isSession(session) || session.finishedAt !== undefined) throw new BackupError('В текущую копию можно отправить только незавершённую тренировку.')
  const data = await request(config, '/v1/draft', { method: 'PUT', body: JSON.stringify({ version: 1, revision, session }) }, signal)
  if (!isDraft(data) || !sameSession(data.session, session)) throw new BackupError('Сервер не подтвердил сохранение текущей тренировки.')
  return data
}
export function confirmedSessionIds(local: WorkoutSession[], remote: WorkoutSession[]): string[] {
  const server = new Map(remote.map(s => [s.id, canonical(s)]))
  return local.filter(s => server.get(s.id) === canonical(s)).map(s => s.id)
}
