import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { categories, isMobilityExercise, workout } from './program'
import { createSession, loadState, minutes, mobilityCompleted, saveState, setMobilityCompleted, stats } from './store'
import type { CompletedSet, StoredState, WorkoutExercise, WorkoutSession } from './types'

type Screen = 'home' | 'workout' | 'focus' | 'summary' | 'history' | 'detail'
type IconName = 'arrow' | 'back' | 'check' | 'play' | 'clock' | 'history' | 'close' | 'home' | 'stretch'
function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    back: <path d="M19 12H5m6-6-6 6 6 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    play: <path d="m9 5 11 7-11 7Z" />,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    history: <><path d="M3 11a9 9 0 1 1 2 7M3 5v6h6M12 7v5l3 2"/></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    home: <><path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/></>,
    stretch: <><circle cx="12" cy="4" r="2"/><path d="m4 8 8 3 8-3M12 11v5m-6 5 6-5 6 5"/></>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}
const date = (value: string) => new Date(value).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
const unit = (e: WorkoutExercise) => e.unit === 'seconds' ? 'сек' : 'повт.'
function Numeric({ value, onChange, label, step = 1, suffix }: { value: number; onChange: (n: number) => void; label: string; step?: number; suffix: string }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  function update(n: number) { onChange(Math.min(999, Math.max(0, Math.round(n * 100) / 100))) }
  return <div className="numeric">
    <button type="button" aria-label={`Уменьшить ${label}`} onClick={() => update(value - step)}>−</button>
    <label className="number-value"><input aria-label={label} inputMode={step === 1 ? 'numeric' : 'decimal'} value={draft} onChange={event => {
      const text = event.target.value.replace(',', '.')
      if (/^\d{0,3}(\.\d{0,2})?$/.test(text)) { setDraft(text); if (text !== '' && !text.endsWith('.')) update(Number(text)) }
    }} onBlur={() => { if (!draft || !Number.isFinite(Number(draft))) setDraft(String(value)); else update(Number(draft)) }} /><span>{suffix}</span></label>
    <button type="button" aria-label={`Увеличить ${label}`} onClick={() => update(value + step)}>+</button>
  </div>
}
function SetEditor({ exercise, sets, onUpdate }: { exercise: WorkoutExercise; sets: CompletedSet[]; onUpdate: (index: number, patch: Partial<CompletedSet>) => void }) {
  return <div className="sets">{sets.map((set, i) => <div className={`set-row ${set.completed ? 'is-done' : ''}`} key={i}>
    <div className="set-heading"><span>Подход {i + 1}</span>{exercise.sets[i].label && <small>{exercise.sets[i].label}</small>}</div>
    <div className={`set-controls ${exercise.defaultWeight !== undefined ? 'weighted' : ''}`}>
      {exercise.defaultWeight !== undefined && <Numeric value={set.weight!} onChange={weight => onUpdate(i, { weight })} label={`Вес, подход ${i + 1}`} suffix="кг" step={0.5} />}
      <Numeric value={set.reps} onChange={reps => onUpdate(i, { reps })} label={`${exercise.unit === 'seconds' ? 'Секунды' : 'Повторения'}, подход ${i + 1}`} suffix={unit(exercise)} />
      <button className="set-check" type="button" aria-label={`Подход ${i + 1} выполнен`} aria-pressed={set.completed} onClick={() => onUpdate(i, { completed: !set.completed })}><Icon name="check" /></button>
    </div>
  </div>)}</div>
}
function Technique({ exercise, onClose }: { exercise: WorkoutExercise; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = overflow; previous?.focus() }
  }, [])
  return <dialog ref={dialog} className="technique" onCancel={onClose} onClick={event => { if (event.target === dialog.current) onClose() }} aria-labelledby="technique-title">
    <div className="sheet-handle"/><div className="sheet-top"><span className="eyebrow">ТЕХНИКА УПРАЖНЕНИЯ</span><button className="icon-button" aria-label="Закрыть технику" onClick={onClose}><Icon name="close"/></button></div>
    <h2 id="technique-title">{exercise.title}</h2>
    <div className="media">{missing ? <><Icon name="stretch" size={64}/><span>Видео пока нет</span><small>Ориентируйся на подсказки ниже</small></> : exercise.techniqueMedia.endsWith('.mp4') ? <video src={exercise.techniqueMedia} controls playsInline onError={() => setMissing(true)} /> : <img src={exercise.techniqueMedia} alt={`Техника: ${exercise.title}`} onError={() => setMissing(true)} />}</div>
    <ol className="tips">{exercise.tips.map(tip => <li key={tip}>{tip}</li>)}</ol><p className="gentle-note">Двигайся в комфортной амплитуде. Если появилась боль — остановись.</p>
  </dialog>
}
export default function App() {
  const [initial] = useState(loadState)
  const [state, setState] = useState<StoredState>(initial.state)
  const [storageError, setStorageError] = useState(initial.error)
  const [screen, setScreen] = useState<Screen>('home')
  const [focus, setFocus] = useState(0)
  const [technique, setTechnique] = useState<WorkoutExercise | null>(null)
  const [selected, setSelected] = useState<WorkoutSession | null>(null)
  const [online, setOnline] = useState(navigator.onLine)
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update); window.addEventListener('offline', update)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])
  function persist(next: StoredState) {
    setStorageError(saveState(next) ? null : 'Не удалось сохранить изменения. Не закрывай приложение: проверь доступ к хранилищу и свободное место.')
    setState(next)
  }
  function go(next: Screen) { setScreen(next); window.scrollTo({ top: 0, behavior: 'instant' }) }
  function begin() {
    if (!state.active) persist({ ...state, active: createSession(state.history) })
    go('workout')
  }
  function changeSet(exerciseIndex: number, setIndex: number, patch: Partial<CompletedSet>) {
    if (!state.active) return
    persist({ ...state, active: { ...state.active, exercises: state.active.exercises.map((e, i) => i !== exerciseIndex ? e : { ...e, sets: e.sets.map((s, j) => j !== setIndex ? s : { ...s, ...patch }) }) } })
  }
  function finish() {
    if (!state.active) return
    const ended = { ...state.active, finishedAt: new Date().toISOString() }
    const next = { ...state, active: null, history: [ended, ...state.history] }
    // Keep the active session and summary on screen if storage is unavailable.
    if (!saveState(next)) { setStorageError('Не удалось сохранить тренировку. Не закрывай приложение и попробуй ещё раз после освобождения места.'); return }
    setState(next); setStorageError(null); go('home')
  }
  const active = state.active
  const progress = active ? stats(active) : null
  const last = state.history[0]
  const current = workout.exercises[focus]
  const elapsed = active ? Math.max(0, Math.floor((now - Date.parse(active.startedAt)) / 1000)) : 0
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`
  const total = workout.exercises.length
  const previous = state.history.find(s => s.exercises[focus].sets.some(set => set.completed))?.exercises[focus]
  function results(session: WorkoutSession) { return <>
    <article className="result-row"><div><h3>{categories[0]}</h3><p>{mobilityCompleted(session) ? 'Блок выполнен' : session.exercises.some((e, i) => isMobilityExercise(workout.exercises[i]) && e.sets.some(s => s.completed)) ? 'Блок выполнен частично' : 'Блок пропущен'}</p></div>{mobilityCompleted(session) && <span className="result-check"><Icon name="check"/></span>}</article>
    {session.exercises.map((entry, i) => !isMobilityExercise(workout.exercises[i]) && <article className="result-row" key={entry.exerciseId}><div><h3>{workout.exercises[i].title}</h3>{entry.sets.map((set, j) => <p key={j}>{entry.sets.length > 1 && `Подход ${j + 1}: `}{set.weight !== undefined && `${set.weight} кг × `}{set.reps} {unit(workout.exercises[i])}{set.completed ? ' · выполнен' : ' · пропущен'}</p>)}</div><span className={entry.sets.every(s => s.completed) ? 'result-check' : 'muted'}>{entry.sets.every(s => s.completed) ? <Icon name="check"/> : '—'}</span></article>)} </> }
  return <div className="app-shell">
    <header className="app-header"><button className="brand" onClick={() => go('home')} aria-label="На главную"><span className="brand-mark"><Icon name="home" size={21}/></span>дома<span className="brand-dot">.</span></button><span className="local-label"><span className={`status-dot ${online ? '' : 'offline'}`}/>{online ? 'Твой ритм. Твоё пространство.' : 'Офлайн · всё под рукой'}</span></header>
    {storageError && <div className="storage-warning" role="alert">{storageError}<button onClick={() => setStorageError(saveState(state) ? null : 'Хранилище всё ещё недоступно. Не закрывай приложение.')}>Повторить сохранение</button></div>}
    <main>
      {screen === 'home' && <>
        <div className="home-intro"><span className="eyebrow">ПРОСТО ВРЕМЯ ДЛЯ СЕБЯ</span><h1>Домашняя<br/>тренировка<span className="title-dot">.</span></h1><p>Знакомые упражнения.<br/>Всё, что нужно — начать.</p></div>
        <section className="start-card"><div className="start-top"><span className="pill">ТВОЯ ПРОГРАММА</span><Icon name="stretch" size={35}/></div><h2>{active ? 'Продолжим?' : 'В своём темпе'}</h2><p>{active ? `${stats(active).exercises} из ${total} упражнений выполнено` : `${total} упражнений · 5 блоков · без спешки`}</p><button className="button primary" onClick={begin}>{active ? 'Продолжить тренировку' : 'Начать тренировку'}<Icon name="arrow"/></button><span className="start-note">{active ? 'Твои подходы и значения сохранены' : 'Результаты сохраняются на этом устройстве'}</span></section>
        <section className="last-session"><div className="section-heading"><h2>Последняя тренировка</h2><Icon name="clock"/></div>{last ? <><p className="last-date">{date(last.startedAt)}</p><div className="last-stats"><div><strong>{minutes(last)}<small> мин</small></strong><span>длительность</span></div><div><strong>{stats(last).exercises}<small> / {total}</small></strong><span>упражнений</span></div></div></> : <div className="empty-last"><span className="empty-icon"><Icon name="clock" size={24}/></span><p>Здесь появится твоя первая тренировка.<small>Начни, когда будешь готов.</small></p></div>}</section>
        <button className="history-link" onClick={() => go('history')}><span><Icon name="history"/>История тренировок</span><Icon name="arrow"/></button>
        <section className="program-overview"><span className="eyebrow">ОДНА ТРЕНИРОВКА. ВСЁ ТЕЛО.</span>{categories.map((category, i) => <div className="program-row" key={category}><span className="block-number">0{i + 1}</span><span>{category}</span><small>{workout.exercises.filter(e => e.category === category).length} упр.</small></div>)}</section>
        <p className="home-footer">Без сравнения. Без рекордов. Для себя.</p>
      </>}
      {screen === 'workout' && active && progress && <>
        <button className="back-link" onClick={() => go('home')}><Icon name="back"/>На главную · сессия сохранена</button>
        <div className="page-heading"><span className="eyebrow">ТВОЯ ТРЕНИРОВКА</span><h1>Движение за<br/>движением.</h1></div>
        <div className="workout-progress"><div><strong>{progress.exercises} / {total} упражнений</strong><span><Icon name="clock" size={16}/>{clock}</span></div><progress value={progress.exercises} max={total} aria-label="Прогресс тренировки"/><small>{progress.sets} из {progress.totalSets} подходов выполнено</small></div>
        {categories.map((category, categoryIndex) => <section className="exercise-block" key={category}><div className="block-heading"><span className="block-number">0{categoryIndex + 1}</span><h2>{category}</h2></div>{categoryIndex === 0 ? <div className={`mobility-card ${mobilityCompleted(active) ? 'completed' : ''}`}>
          <p className="mobility-note">Двигайся в своём темпе. Отметь весь блок, когда закончишь.</p>
          {workout.exercises.filter(isMobilityExercise).map((exercise, i) => <div className="mobility-row" key={exercise.id}><span className="card-index">{String(i + 1).padStart(2, '0')}</span><h3>{exercise.title}</h3><button className="technique-link" aria-label={`Техника: ${exercise.title}`} onClick={() => setTechnique(exercise)}><Icon name="play" size={16}/>Техника</button></div>)}
          <label className="mobility-complete"><input type="checkbox" checked={mobilityCompleted(active)} onChange={event => persist({ ...state, active: setMobilityCompleted(active, event.target.checked) })}/><span className="mobility-checkbox"><Icon name="check"/></span><span>Блок «Корпус + мобилити» выполнен</span></label>
        </div> : workout.exercises.map((exercise, i) => exercise.category === category && <article className={`exercise-card ${active.exercises[i].sets.every(s => s.completed) ? 'completed' : ''}`} key={exercise.id}>
          <button className="exercise-open" onClick={() => { setFocus(i); go('focus') }}><div><span className="card-index">{String(i + 1).padStart(2, '0')}{active.exercises[i].sets.every(s => s.completed) && ' · ВЫПОЛНЕНО'}</span><h3>{exercise.title}</h3><p>План: {exercise.plan}</p>{exercise.weightNote && <small>{exercise.weightNote}</small>}</div><Icon name={active.exercises[i].sets.every(s => s.completed) ? 'check' : 'arrow'}/></button>
          <SetEditor exercise={exercise} sets={active.exercises[i].sets} onUpdate={(j, patch) => changeSet(i, j, patch)}/><button className="technique-link" onClick={() => setTechnique(exercise)}><Icon name="play" size={16}/>Техника</button>
        </article>)}</section>)}
        <div className="sticky-actions"><button className="button primary" onClick={() => go('summary')}>{progress.exercises === total ? 'К завершению' : 'Завершить тренировку'}<Icon name="arrow"/></button></div>
      </>}
      {screen === 'focus' && active && <>
        <button className="back-link" onClick={() => go('workout')}><Icon name="back"/>Все упражнения</button><div className="focus-progress"><span>Упражнение <strong>{focus + 1} / {total}</strong></span><span>{clock}</span><progress value={focus + 1} max={total} aria-label="Текущее упражнение"/></div>
        <div className="focus-title"><span className="eyebrow">{current.category.toLocaleUpperCase('ru-RU')}</span><h1>{current.title}</h1><p>План: {current.plan}</p>{current.weightNote && <small>{current.weightNote}</small>}</div>
        <div className="previous"><Icon name="history"/><div><span>Прошлый раз</span><p>{previous ? previous.sets.map((s, j) => `${s.weight !== undefined ? `${s.weight} кг × ` : ''}${s.reps} ${unit(current)}${s.completed ? '' : ' (пропущен)'}`).join(' · ') : 'Первый раз — начни со значений программы'}</p></div></div>
        <div className="today-heading"><h2>Сегодня</h2><span>{active.exercises[focus].sets.every(s => s.completed) ? 'Выполнено ✓' : `${active.exercises[focus].sets.filter(s => s.completed).length} / ${current.sets.length} подходов`}</span></div>
        <div className="focus-editor"><SetEditor exercise={current} sets={active.exercises[focus].sets} onUpdate={(j, patch) => changeSet(focus, j, patch)}/></div>
        {/на сторону|каждую сторону/.test(current.plan) && <p className="side-note">Отметь подход после выполнения обеих сторон.</p>}
        <button className="button secondary" onClick={() => setTechnique(current)}><Icon name="play"/>Техника упражнения</button>
        <div className="sticky-actions"><button className="button primary" onClick={() => { if (focus === total - 1) go('summary'); else { setFocus(focus + 1); window.scrollTo({ top: 0 }) } }}>{focus === total - 1 ? 'К завершению' : 'Следующее упражнение'}<Icon name="arrow"/></button>{focus > workout.exercises.filter(isMobilityExercise).length && <button className="text-button" onClick={() => { setFocus(focus - 1); window.scrollTo({ top: 0 }) }}>← Предыдущее упражнение</button>}</div>
      </>}
      {screen === 'summary' && active && progress && <>
        <button className="back-link" onClick={() => go('workout')}><Icon name="back"/>Вернуться к упражнениям</button><div className="summary-hero"><span className="success-orbit"><Icon name="check" size={44}/></span><span className="eyebrow">ВРЕМЯ ДЛЯ СЕБЯ — ПРОВЕДЕНО</span><h1>{progress.exercises === total ? 'Тренировка\nзавершена 💪' : 'Отличная\nработа 💪'}</h1><p>{progress.exercises === total ? 'Все упражнения позади. Можно выдохнуть.' : 'Сохрани то, что удалось сделать сегодня.'}</p></div><div className="summary-stats"><div><strong>{minutes(active)}</strong><span>минут</span></div><div><strong>{progress.exercises}<small>/{total}</small></strong><span>упражнений</span></div><div><strong>{progress.sets}<small>/{progress.totalSets}</small></strong><span>подходов</span></div></div>{progress.exercises < total && <p className="side-note">Невыполненные подходы сохранятся как пропущенные.</p>}<button className="button primary" onClick={finish}>Завершить и сохранить<Icon name="check"/></button><p className="save-note">Результаты появятся в истории и помогут в следующий раз.</p>
      </>}
      {screen === 'history' && <><button className="back-link" onClick={() => go('home')}><Icon name="back"/>На главную</button><div className="page-heading"><span className="eyebrow">ТВОЙ ПУТЬ</span><h1>История<br/>тренировок.</h1></div>{state.history.length ? <div className="history-list">{state.history.map(session => <button className="history-card" key={session.id} onClick={() => { setSelected(session); go('detail') }}><span className="history-icon"><Icon name="check"/></span><div><h2>{date(session.startedAt)}</h2><p>Домашняя тренировка</p><small>{minutes(session)} мин · {stats(session).exercises} / {total} упражнений</small></div><Icon name="arrow"/></button>)}</div> : <div className="empty-history"><Icon name="history" size={48}/><h2>Начало ещё впереди</h2><p>После завершения тренировки<br/>её результаты будут здесь.</p><button className="button primary" onClick={begin}>{active ? 'Продолжить тренировку' : 'Начать тренировку'}<Icon name="arrow"/></button></div>}</>}
      {screen === 'detail' && selected && <><button className="back-link" onClick={() => go('history')}><Icon name="back"/>История тренировок</button><div className="page-heading"><span className="eyebrow">{date(selected.startedAt)}</span><h1>Домашняя<br/>тренировка.</h1><p>{minutes(selected)} мин · {stats(selected).exercises} / {total} упражнений · {stats(selected).sets} подходов</p></div><section className="results">{results(selected)}</section></>}
    </main>
    {technique && <Technique key={technique.id} exercise={technique} onClose={() => setTechnique(null)}/>}
  </div>
}
