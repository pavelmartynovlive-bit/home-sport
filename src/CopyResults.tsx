import { useEffect, useRef, useState } from 'react'
import { formatWorkoutResults } from './export'
import type { WorkoutSession } from './types'

function ManualCopy({ text, onClose }: { text: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    dialog.current?.showModal()
    textarea.current?.focus()
    textarea.current?.select()
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = overflow; previous?.focus() }
  }, [])
  return <dialog ref={dialog} className="technique copy-dialog" aria-labelledby="copy-title" onCancel={onClose} onClick={event => { if (event.target === dialog.current) onClose() }}>
    <div className="sheet-handle"/>
    <h2 id="copy-title">Результаты текстом</h2>
    <p>Автоматическое копирование недоступно. Выдели текст и выбери «Скопировать» в меню телефона.</p>
    <textarea ref={textarea} readOnly value={text} aria-label="Текст результатов тренировки"/>
    <button className="button secondary" onClick={() => { textarea.current?.focus(); textarea.current?.select() }}>Выделить весь текст</button>
    <button className="button primary" onClick={onClose}>Закрыть</button>
  </dialog>
}
export default function CopyResults({ session }: { session: WorkoutSession }) {
  const [copied, setCopied] = useState(false)
  const [manualText, setManualText] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timeout = window.setTimeout(() => setCopied(false), 3000)
    return () => window.clearTimeout(timeout)
  }, [copied])
  async function copy() {
    const text = formatWorkoutResults(session)
    setCopied(false)
    setBusy(true)
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch { setManualText(text) }
    finally { setBusy(false) }
  }
  return <div className="copy-tools">
    <button className="icon-button copy-button" aria-label="Скопировать результаты" title="Скопировать результаты" disabled={busy} onClick={copy}>
      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>
    </button>
    <span className="copy-status" role="status">{copied ? 'Скопировано' : ''}</span>
    {manualText !== null && <ManualCopy text={manualText} onClose={() => setManualText(null)}/>}
  </div>
}
