export interface ExerciseSet { reps: number; label?: string }
export interface WorkoutExercise {
  id: string; title: string; category: string; type: 'strength' | 'mobility' | 'stretch';
  plan: string; defaultWeight?: number; weightNote?: string; unit: 'reps' | 'seconds';
  sets: ExerciseSet[]; tips: string[]; techniqueMedia: string;
}
export interface Workout { id: string; title: string; exercises: WorkoutExercise[] }
export interface CompletedSet { weight?: number; reps: number; completed: boolean }
export interface SessionExercise { exerciseId: string; sets: CompletedSet[] }
export interface WorkoutSession {
  id: string; workoutId: string; startedAt: string; finishedAt?: string; exercises: SessionExercise[];
}
export interface StoredState { version: 1; active: WorkoutSession | null; history: WorkoutSession[] }
