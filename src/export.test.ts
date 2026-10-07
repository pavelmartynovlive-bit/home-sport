import { describe, expect, it } from 'vitest'
import { formatWorkoutResults } from './export'
import { createSession, setBlockCompleted } from './store'
import { categories } from './program'

describe('workout text for messages', () => {
  it('keeps historical shrugs correctly named without rewriting them as floor presses', () => {
    const session = createSession([])
    session.exercises[17].exerciseId = 'shrugs'
    expect(formatWorkoutResults(session)).toContain('Шраги')
    expect(formatWorkoutResults(session)).not.toContain('Жим гантелей лёжа на полу')
  })
  it('exports distinct actual weights, completed and skipped sets, labels and whole-block status', () => {
    const session = setBlockCompleted(createSession([], new Date('2026-10-06T10:00:00Z')), categories[0], true)
    session.finishedAt = '2026-10-06T10:42:00Z'
    session.exercises[15].sets = [{ weight: 9.5, reps: 12, completed: true }, { weight: 7, reps: 10, completed: false }]
    const text = formatWorkoutResults(session)
    expect(text).toContain('Время: 42 мин')
    expect(text).toContain('Упражнения: 10 / 30')
    expect(text).toContain('Подходы: 1 / 22')
    expect(text).toContain('Подход 1: 9,5 кг × 12 повт. · ✓ выполнен')
    expect(text).toContain('Подход 2: 7 кг × 10 повт. · — не выполнен')
    expect(text).toContain('Молотки · 8 + 8 + 8')
    expect(text).toContain('12 повт. на сторону')
    expect(text).toContain('Корпус + мобилити\n✓ Блок выполнен')
    expect(text).toContain('Растяжка\n— Блок пропущен')
    expect(text).not.toContain('Кошка-собака')
    expect(text).not.toContain('30 сек')
  })
  it('keeps old partially completed block results explicit without changing data', () => {
    const session = createSession([])
    session.exercises[25].sets[0].completed = true
    const before = JSON.stringify(session)
    expect(formatWorkoutResults(session)).toContain('Растяжка\nБлок выполнен частично')
    expect(JSON.stringify(session)).toBe(before)
  })
})
