import { isBlockExercise, workout } from './program'
import type { StoredState, WorkoutSession } from './types'
export const STORAGE_KEY = 'home-sport:v1'
export const emptyState = (): StoredState => ({ version: 1, active: null, history: [] })
function isSession(value: unknown): value is WorkoutSession {
  if (!value || typeof value !== 'object') return false
  const s = value as WorkoutSession
  return typeof s.id === 'string' && s.workoutId === workout.id && typeof s.startedAt === 'string' && Number.isFinite(Date.parse(s.startedAt)) &&
    (s.finishedAt === undefined || (typeof s.finishedAt === 'string' && Number.isFinite(Date.parse(s.finishedAt)))) &&
    Array.isArray(s.exercises) && s.exercises.length === workout.exercises.length &&
    s.exercises.every((e, i) => e.exerciseId === workout.exercises[i].id && Array.isArray(e.sets) && e.sets.length === workout.exercises[i].sets.length &&
      e.sets.every(set => Number.isFinite(set.reps) && set.reps >= 0 && typeof set.completed === 'boolean' &&
        (workout.exercises[i].defaultWeight === undefined ? set.weight === undefined : Number.isFinite(set.weight) && set.weight! >= 0)))
}
export function loadState(): { state: StoredState; error: string | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { state: emptyState(), error: null }
    const parsed = JSON.parse(raw)
    if (parsed.version !== 1 || !Array.isArray(parsed.history) || !parsed.history.every(isSession) || !(parsed.active === null || isSession(parsed.active))) throw new Error('invalid')
    return { state: parsed, error: null }
  } catch { return { state: emptyState(), error: 'Не удалось прочитать сохранённые данные. Исходная запись не изменена. Освободи место или проверь доступ к хранилищу.' } }
}
export function saveState(state: StoredState): boolean {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return true } catch { return false }
}
export function createSession(history: WorkoutSession[], now = new Date()): WorkoutSession {
  return { id: crypto.randomUUID(), workoutId: workout.id, startedAt: now.toISOString(), exercises: workout.exercises.map(exercise => {
    // Use the most recent actually completed set, including when a later session was partial.
    return { exerciseId: exercise.id, sets: exercise.sets.map((set, index) => {
      const previous = history.map(s => s.exercises.find(e => e.exerciseId === exercise.id)?.sets[index]).find(s => s?.completed)
      return { reps: previous?.reps ?? set.reps, ...(exercise.defaultWeight !== undefined ? { weight: previous?.weight ?? exercise.defaultWeight } : {}), completed: false }
    }) }
  }) }
}
// Keep the existing per-exercise storage format so saved sessions remain compatible.
export function blockCompleted(session: WorkoutSession, category: string): boolean {
  return session.exercises.filter((_, i) => workout.exercises[i].category === category).every(e => e.sets.every(s => s.completed))
}
export function setBlockCompleted(session: WorkoutSession, category: string, completed: boolean): WorkoutSession {
  return { ...session, exercises: session.exercises.map((e, i) => workout.exercises[i].category === category ? { ...e, sets: e.sets.map(s => ({ ...s, completed })) } : e) }
}
export function stats(session: WorkoutSession) {
  const tracked = session.exercises.filter((_, i) => !isBlockExercise(workout.exercises[i]))
  return { exercises: session.exercises.filter(e => e.sets.every(s => s.completed)).length, sets: tracked.reduce((n, e) => n + e.sets.filter(s => s.completed).length, 0), totalSets: tracked.reduce((n, e) => n + e.sets.length, 0) }
}
export function minutes(session: WorkoutSession) { return Math.max(1, Math.round((Date.parse(session.finishedAt ?? new Date().toISOString()) - Date.parse(session.startedAt)) / 60000)) }
