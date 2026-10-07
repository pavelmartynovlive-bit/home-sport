import { categories, isBlockExercise, workout } from './program'
import type { StoredState, WorkoutExercise, WorkoutSession } from './types'
export const STORAGE_KEY = 'home-sport:v1'
export const emptyState = (): StoredState => ({ version: 1, active: null, history: [] })
// Metadata for immutable history only; removed exercises never enter new sessions.
const legacyCalfRaise: WorkoutExercise = {
  id: 'calf-raise', title: 'Подъёмы на носки', category: categories[3], type: 'strength',
  plan: '2 × 15–20', unit: 'reps', sets: [{ reps: 20 }, { reps: 20 }], tips: [], techniqueMedia: '',
}
export function sessionExercise(exerciseId: string): WorkoutExercise {
  if (exerciseId === 'calf-raise') return legacyCalfRaise
  if (exerciseId === 'shrugs') return { ...workout.exercises.find(e => e.id === 'floor-press')!, id: 'shrugs', title: 'Шраги' }
  return workout.exercises.find(e => e.id === exerciseId)!
}
const legacyExercises = [...workout.exercises]
legacyExercises.splice(legacyExercises.findIndex(e => e.id === 'side-lying-leg'), 0, legacyCalfRaise)
export function isSession(value: unknown): value is WorkoutSession {
  if (!value || typeof value !== 'object') return false
  const s = value as WorkoutSession
  const program = Array.isArray(s.exercises) && s.exercises.length === legacyExercises.length ? legacyExercises : workout.exercises
  return typeof s.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(s.id) && s.workoutId === workout.id && typeof s.startedAt === 'string' && Number.isFinite(Date.parse(s.startedAt)) &&
    (s.finishedAt === undefined || (typeof s.finishedAt === 'string' && Number.isFinite(Date.parse(s.finishedAt)))) &&
    Array.isArray(s.exercises) && s.exercises.length === program.length &&
    s.exercises.every((e, i) => !!e && typeof e === 'object' && (e.exerciseId === program[i].id || (e.exerciseId === 'shrugs' && program[i].id === 'floor-press')) && Array.isArray(e.sets) && e.sets.length === program[i].sets.length &&
      e.sets.every(set => !!set && typeof set === 'object' && Number.isFinite(set.reps) && set.reps >= 0 && typeof set.completed === 'boolean' &&
        (program[i].defaultWeight === undefined ? set.weight === undefined : Number.isFinite(set.weight) && set.weight! >= 0)))
}
// Keep completed legacy records unchanged: the backup API treats history as immutable.
export function sessionExerciseTitle(exerciseId: string): string {
  return sessionExercise(exerciseId).title
}
export function upgradeActiveSession(session: WorkoutSession): WorkoutSession {
  if (!session.exercises.some(e => e.exerciseId === 'shrugs' || e.exerciseId === 'calf-raise')) return session
  const exercise = sessionExercise('floor-press')
  return { ...session, exercises: session.exercises.filter(e => e.exerciseId !== 'calf-raise').map(entry => entry.exerciseId !== 'shrugs' ? entry : {
    exerciseId: exercise.id, sets: exercise.sets.map(set => ({ reps: set.reps, weight: exercise.defaultWeight, completed: false })),
  }) }
}
export function loadState(): { state: StoredState; error: string | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { state: emptyState(), error: null }
    const parsed = JSON.parse(raw)
    if (parsed.version !== 1 || !Array.isArray(parsed.history) || !parsed.history.every(isSession) || !(parsed.active === null || isSession(parsed.active))) throw new Error('invalid')
    const active = parsed.active ? upgradeActiveSession(parsed.active) : null
    if (active !== parsed.active) {
      const state = { ...parsed, active }
      return { state, error: saveState(state) ? null : 'Не удалось сохранить обновлённую текущую тренировку. Проверь доступ к хранилищу.' }
    }
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
  return session.exercises.filter(e => sessionExercise(e.exerciseId).category === category).every(e => e.sets.every(s => s.completed))
}
export function setBlockCompleted(session: WorkoutSession, category: string, completed: boolean): WorkoutSession {
  return { ...session, exercises: session.exercises.map(e => sessionExercise(e.exerciseId).category === category ? { ...e, sets: e.sets.map(s => ({ ...s, completed })) } : e) }
}
export function stats(session: WorkoutSession) {
  const tracked = session.exercises.filter(e => !isBlockExercise(sessionExercise(e.exerciseId)))
  return { exercises: session.exercises.filter(e => e.sets.every(s => s.completed)).length, sets: tracked.reduce((n, e) => n + e.sets.filter(s => s.completed).length, 0), totalSets: tracked.reduce((n, e) => n + e.sets.length, 0) }
}
export function minutes(session: WorkoutSession) { return Math.max(1, Math.round((Date.parse(session.finishedAt ?? new Date().toISOString()) - Date.parse(session.startedAt)) / 60000)) }
