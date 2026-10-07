import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createSession, emptyState, isSession, loadState, saveState, stats, blockCompleted, setBlockCompleted, STORAGE_KEY } from './store'
import { categories, workout } from './program'
let values: Map<string, string>
beforeEach(() => {
  values = new Map()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
})
describe('personal workout storage', () => {
  it('replaces shrugs with floor press while preserving immutable legacy history and other active exercises', () => {
    const index = workout.exercises.findIndex(e => e.id === 'floor-press')
    expect(workout.exercises.some(e => e.id === 'shrugs')).toBe(false)
    const legacy = createSession([])
    legacy.exercises[index] = { exerciseId: 'shrugs', sets: [{ reps: 18, weight: 12, completed: true }, { reps: 16, weight: 12, completed: false }] }
    legacy.exercises[15].sets[0] = { reps: 12, weight: 9.5, completed: true }
    const history = [{ ...legacy, id: 'legacy-history', finishedAt: new Date().toISOString() }]
    expect(isSession(history[0])).toBe(true)
    expect(createSession(history).exercises[index]).toEqual({ exerciseId: 'floor-press', sets: [{ reps: 15, weight: 8, completed: false }, { reps: 15, weight: 8, completed: false }] })
    saveState({ ...emptyState(), active: legacy, history })
    const restored = loadState()
    expect(restored.error).toBeNull()
    expect(restored.state.history).toEqual(history)
    expect(restored.state.active?.exercises[index]).toEqual(createSession([]).exercises[index])
    expect(restored.state.active?.exercises.filter((_, i) => i !== index)).toEqual(legacy.exercises.filter((_, i) => i !== index))
    expect(loadState()).toEqual(restored)
  })
  it('removes calf raises from active sessions while preserving legacy history and later exercises', () => {
    expect(workout.exercises.some(e => e.id === 'calf-raise')).toBe(false)
    const legacy = createSession([])
    legacy.exercises.splice(22, 0, { exerciseId: 'calf-raise', sets: [{ reps: 19, completed: true }, { reps: 17, completed: true }] })
    legacy.exercises[23].sets[0] = { reps: 14, completed: true }
    legacy.exercises[25].sets[0] = { reps: 45, completed: true }
    const history = [{ ...legacy, id: 'old-with-calves', finishedAt: new Date().toISOString() }]
    expect(isSession(legacy)).toBe(true)
    expect(stats(history[0])).toEqual({ exercises: 3, sets: 3, totalSets: 22 })
    saveState({ ...emptyState(), active: legacy, history })
    const restored = loadState()
    expect(restored.error).toBeNull()
    expect(restored.state.history).toEqual(history)
    expect(restored.state.active?.exercises).toEqual(legacy.exercises.filter(e => e.exerciseId !== 'calf-raise'))
    expect(isSession(restored.state.active)).toBe(true)
    expect(createSession(history).exercises[22].sets[0].reps).toBe(14)
    expect(createSession(history).exercises[24].sets[0].reps).toBe(45)
    expect(loadState()).toEqual(restored)
    const malformed = structuredClone(legacy)
    malformed.exercises[22].exerciseId = 'unknown'
    expect(isSession(malformed)).toBe(false)
  })
  it('contains the complete 29-exercise program, with distinct timed and weighted sets', () => {
    const s = createSession([])
    expect(s.exercises).toHaveLength(29)
    expect(s.exercises[13].sets.map(s => s.reps)).toEqual([15, 24])
    expect(s.exercises[15].sets[0].weight).toBe(8)
    expect(s.exercises[0].sets[0].weight).toBeUndefined()
    expect(workout.exercises[9].unit).toBe('seconds')
    expect(stats(s)).toEqual({ exercises: 0, sets: 0, totalSets: 20 })
  })
  it('toggles the entire mobility block without changing other exercises or losing legacy values', () => {
    const original = createSession([])
    original.exercises[0].sets[0] = { reps: 9, completed: true }
    original.exercises[15].sets[0] = { reps: 12, weight: 9.5, completed: true }
    expect(blockCompleted(original, categories[0])).toBe(false)
    const checked = setBlockCompleted(original, categories[0], true)
    expect(blockCompleted(checked, categories[0])).toBe(true)
    expect(stats(checked)).toEqual({ exercises: 10, sets: 1, totalSets: 20 })
    expect(checked.exercises[0].sets[0].reps).toBe(9)
    expect(checked.exercises[15]).toEqual(original.exercises[15])
    const unchecked = setBlockCompleted(checked, categories[0], false)
    expect(blockCompleted(unchecked, categories[0])).toBe(false)
    expect(unchecked.exercises.slice(0, 10).every(e => e.sets.every(s => !s.completed))).toBe(true)
    expect(stats(unchecked).exercises).toBe(0)
    const state = { ...emptyState(), active: checked, history: [original] }
    expect(saveState(state)).toBe(true)
    expect(loadState().state).toEqual(state)
    expect(blockCompleted(createSession([checked]), categories[0])).toBe(false)
  })
  it('tracks stretching separately from mobility and preserves saved seconds', () => {
    const original = createSession([])
    original.exercises[24].sets[0] = { reps: 45, completed: true }
    expect(blockCompleted(original, categories[4])).toBe(false)
    const checked = setBlockCompleted(original, categories[4], true)
    expect(blockCompleted(checked, categories[4])).toBe(true)
    expect(blockCompleted(checked, categories[0])).toBe(false)
    expect(stats(checked)).toEqual({ exercises: 5, sets: 0, totalSets: 20 })
    expect(checked.exercises[24].sets[0].reps).toBe(45)
    expect(checked.exercises.slice(0, 24)).toEqual(original.exercises.slice(0, 24))
    const state = { ...emptyState(), active: checked, history: [original] }
    expect(saveState(state)).toBe(true)
    expect(loadState().state).toEqual(state)
    expect(blockCompleted(setBlockCompleted(checked, categories[4], false), categories[4])).toBe(false)
    expect(blockCompleted(createSession([checked]), categories[4])).toBe(false)
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
