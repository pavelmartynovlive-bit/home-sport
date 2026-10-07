import { afterEach, describe, expect, it, vi } from 'vitest'
import { confirmedSessionIds, fetchBackup, mergeHistory, normalizeBackupUrl, pendingSessions, uploadSession } from './backup'
import { createSession } from './store'
const config = { url: 'https://backup.example.com', key: 'test-only-access-key-not-a-real-secret', savedIds: [] }
function completed(id = 'session-test') {
  const s = createSession([]); s.id = id; s.finishedAt = new Date().toISOString(); return s
}
afterEach(() => vi.unstubAllGlobals())
describe('backup transport and restoration', () => {
  it('requires HTTPS and disallows credentials, fragments, and query strings', () => {
    expect(normalizeBackupUrl('https://backup.example.com/')).toBe('https://backup.example.com')
    expect(normalizeBackupUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
    for (const url of ['http://backup.example.com', 'https://user:password@backup.example.com', 'https://backup.example.com?key=secret', 'https://backup.example.com#token']) expect(() => normalizeBackupUrl(url)).toThrow()
  })
  it('restoration merges IDs, keeps local collision values, and never deletes local history', () => {
    const local = completed('local'); const remote = completed('remote')
    const collision = { ...local, exercises: [] }
    expect(mergeHistory([local], [remote, collision])).toHaveLength(2)
    expect(mergeHistory([local], [remote, collision]).find(s => s.id === 'local')).toEqual(local)
    expect(mergeHistory([local], [])).toEqual([local])
  })
  it('queues only finished sessions that have not been acknowledged', () => {
    const a = completed('a'); const b = completed('b')
    expect(pendingSessions([a, b, createSession([])], { ...config, savedIds: ['a'] })).toEqual([b])
  })
  it('reconciles acknowledgements against actual server records independent of object key order', () => {
    const a = completed('a'); const b = completed('b'); const missing = completed('missing')
    const reordered = { exercises: a.exercises, finishedAt: a.finishedAt, startedAt: a.startedAt, workoutId: a.workoutId, id: a.id }
    const conflict = { ...b, exercises: b.exercises.map((e, i) => i ? e : { ...e, sets: e.sets.map(s => ({ ...s, reps: s.reps + 1 })) }) }
    expect(confirmedSessionIds([a, b, missing], [reordered, conflict])).toEqual(['a'])
  })
  it('requires a matching database acknowledgement and avoids redirects and credential cookies', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ saved: true, id: 'session-test' }) })
    vi.stubGlobal('fetch', request)
    await uploadSession(config, completed())
    expect(request).toHaveBeenCalledWith('https://backup.example.com/v1/sessions/session-test', expect.objectContaining({ method: 'PUT', redirect: 'error', credentials: 'omit', cache: 'no-store' }))
    request.mockResolvedValue({ ok: true, json: async () => ({ saved: false, id: 'session-test' }) })
    await expect(uploadSession(config, completed())).rejects.toThrow('не подтвердил')
  })
  it('rejects wrong schema, duplicate IDs and unsuccessful authentication before restoration', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: 1, sessions: [completed(), completed()] }) })
    vi.stubGlobal('fetch', request)
    await expect(fetchBackup(config)).rejects.toThrow('повторяющиеся')
    request.mockResolvedValue({ ok: true, json: async () => ({ version: 1, sessions: [createSession([])] }) })
    await expect(fetchBackup(config)).rejects.toThrow('Формат')
    const malformed = completed(); malformed.exercises[0] = null as never
    request.mockResolvedValue({ ok: true, json: async () => ({ version: 1, sessions: [malformed] }) })
    await expect(fetchBackup(config)).rejects.toThrow('Формат')
    request.mockResolvedValue({ ok: false, status: 401 })
    await expect(fetchBackup(config)).rejects.toThrow('ключ')
  })
})
