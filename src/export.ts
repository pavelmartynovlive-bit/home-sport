import { categories, workout } from './program'
import { blockCompleted, minutes, sessionExercise, sessionExerciseTitle, stats } from './store'
import type { WorkoutSession } from './types'

export function formatWorkoutResults(session: WorkoutSession): string {
  const totals = stats(session)
  const date = new Date(session.startedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
  const lines = [workout.title, date, `Время: ${minutes(session)} мин`, `Упражнения: ${totals.exercises} / ${session.exercises.length}`, `Подходы: ${totals.sets} / ${totals.totalSets}`]
  for (const category of categories) {
    lines.push('', category)
    const entries = session.exercises.filter(e => sessionExercise(e.exerciseId).category === category)
    if (category === categories[0] || category === categories[4]) {
      lines.push(blockCompleted(session, category) ? '✓ Блок выполнен' : entries.some(e => e.sets.some(s => s.completed)) ? 'Блок выполнен частично' : '— Блок пропущен')
      continue
    }
    for (const entry of entries) {
      const exercise = sessionExercise(entry.exerciseId)
      lines.push(sessionExerciseTitle(entry.exerciseId))
      entry.sets.forEach((set, index) => {
        const label = exercise.sets[index].label
        const weight = set.weight !== undefined ? `${set.weight.toLocaleString('ru-RU')} кг × ` : ''
        const perSide = exercise.plan.includes('на сторону') ? ' на сторону' : exercise.id === 'knee-circles' ? ' в каждую сторону каждой ногой' : ''
        lines.push(`  Подход ${index + 1}${label ? ` (${label})` : ''}: ${weight}${set.reps} ${exercise.unit === 'seconds' ? 'сек' : 'повт.'}${perSide} · ${set.completed ? '✓ выполнен' : '— не выполнен'}`)
      })
    }
  }
  return lines.join('\n')
}
