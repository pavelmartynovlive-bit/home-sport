import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createSession, emptyState, loadState, saveState, stats, mobilityCompleted, setMobilityCompleted, STORAGE_KEY } from './store'
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
    expect(stats(s)).toEqual({ exercises: 0, sets: 0, totalSets: 27 })
  })
  it('toggles the entire mobility block without changing other exercises or losing legacy values', () => {
    const original = createSession([])
    original.exercises[0].sets[0] = { reps: 9, completed: true }
    original.exercises[15].sets[0] = { reps: 12, weight: 9.5, completed: true }
    expect(mobilityCompleted(original)).toBe(false)
    const checked = setMobilityCompleted(original, true)
    expect(mobilityCompleted(checked)).toBe(true)
    expect(stats(checked)).toEqual({ exercises: 10, sets: 1, totalSets: 27 })
    expect(checked.exercises[0].sets[0].reps).toBe(9)
    expect(checked.exercises[15]).toEqual(original.exercises[15])
    const unchecked = setMobilityCompleted(checked, false)
    expect(mobilityCompleted(unchecked)).toBe(false)
    expect(unchecked.exercises.slice(0, 10).every(e => e.sets.every(s => !s.completed))).toBe(true)
    expect(stats(unchecked).exercises).toBe(0)
    const state = { ...emptyState(), active: checked, history: [original] }
    expect(saveState(state)).toBe(true)
    expect(loadState().state).toEqual(state)
    expect(mobilityCompleted(createSession([checked]))).toBe(false)
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
