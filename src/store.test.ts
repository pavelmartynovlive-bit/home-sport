import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createSession, emptyState, loadState, saveState, stats, STORAGE_KEY } from './store'
import { workout } from './program'
let values: Map<string, string>
beforeEach(() => {
  values = new Map()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
})
describe('personal workout storage', () => {
  it('contains the complete 30-exercise program, with distinct timed and weighted sets', () => {
    const s = createSession([])
    expect(s.exercises).toHaveLength(30)
    expect(s.exercises[13].sets.map(s => s.reps)).toEqual([15, 24])
    expect(s.exercises[15].sets[0].weight).toBe(8)
    expect(s.exercises[0].sets[0].weight).toBeUndefined()
    expect(workout.exercises[9].unit).toBe('seconds')
    expect(stats(s)).toEqual({ exercises: 0, sets: 0, totalSets: 37 })
  })
  it('reuses actual completed values per set, falling back past partial sessions', () => {
    const older = createSession([])
    older.exercises[15].sets = [{ reps: 12, weight: 9, completed: true }, { reps: 10, weight: 7, completed: true }]
    const newer = createSession([])
    newer.exercises[15].sets = [{ reps: 14, weight: 10, completed: true }, { reps: 0, weight: 0, completed: false }]
    expect(createSession([newer, older]).exercises[15].sets).toEqual([{ reps: 14, weight: 10, completed: false }, { reps: 10, weight: 7, completed: false }])
  })
  it('round trips the active session and completed history without losing set values', () => {
    const s = createSession([])
    s.exercises[0].sets[0].completed = true
    const state = { ...emptyState(), active: s, history: [{ ...s, id: 'old', finishedAt: new Date().toISOString() }] }
    expect(saveState(state)).toBe(true)
    expect(loadState()).toEqual({ state, error: null })
  })
  it('preserves invalid data and reports it instead of silently overwriting', () => {
    values.set(STORAGE_KEY, '{broken')
    expect(loadState().error).not.toBeNull()
    expect(values.get(STORAGE_KEY)).toBe('{broken')
  })
  it('rejects malformed set values', () => {
    const s = createSession([])
    s.exercises[0].sets[0].reps = -1
    values.set(STORAGE_KEY, JSON.stringify({ ...emptyState(), active: s }))
    expect(loadState().error).not.toBeNull()
  })
  it('reports storage failures', () => {
    vi.stubGlobal('localStorage', { setItem: () => { throw new Error('quota') }, getItem: () => { throw new Error('blocked') } })
    expect(saveState(emptyState())).toBe(false)
    expect(loadState().error).not.toBeNull()
  })
})
