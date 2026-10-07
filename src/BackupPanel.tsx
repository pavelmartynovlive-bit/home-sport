import { useState } from 'react'
import { BackupError } from './backup'
import type { useBackup } from './useBackup'
type Backup = ReturnType<typeof useBackup>
export default function BackupPanel({ backup }: { backup: Backup }) {
  const [url, setUrl] = useState(backup.config?.url || '')
  const [key, setKey] = useState('')
  const [editing, setEditing] = useState(!backup.config)
  const [working, setWorking] = useState(false)
  const [message, setMessage] = useState('')
  const disabled = working || backup.busy
  async function connect(event: React.FormEvent) {
    event.preventDefault()
    setWorking(true); setMessage('')
    try { await backup.connect(url, key); setEditing(false); setKey(''); setMessage('Подключение сохранено на телефоне. Проверяем историю и отправляем недостающие тренировки.') }
    catch (error) { setMessage(error instanceof BackupError ? error.message : 'Не удалось подключиться. Проверь адрес, HTTPS и доступность сервера.') }
    finally { setWorking(false) }
  }
  async function restore() {
    setWorking(true); setMessage('')
    try { const added = await backup.restore(); setMessage(added ? `Добавлено тренировок: ${added}. Текущая сессия сохранена.` : 'Новых тренировок в копии нет. Текущая сессия сохранена.') }
    catch (error) { setMessage(error instanceof BackupError ? error.message : 'Не удалось получить копию. Проверь доступ к хранилищу и попробуй позже.') }
    finally { setWorking(false) }
  }
  return <section className="backup-panel">
    <h2>Резервная копия</h2>
    <p className="backup-status" role="status">Сохранено на телефоне. {backup.status}{backup.pending > 0 && ` · ожидают отправки: ${backup.pending}`}</p>
    <p className="draft-status" role="status">{backup.draftStatus}</p>
    <p className="backup-explanation">При открытии возвращаем недостающую историю и текущую тренировку с сервера. Изменения текущей тренировки копируются через 3 секунды после последнего изменения. Без интернета продолжаешь заниматься — отправим копию при возвращении связи.</p>
    {backup.config && <>
      <p className="backup-address">{backup.config.url}</p>
      <button className="button secondary" disabled={disabled} onClick={() => void backup.sync()}>Отправить копию сейчас</button>
      <button className="button secondary" disabled={disabled} onClick={() => void restore()}>Восстановить историю с сервера</button>
      <button className="text-button" disabled={disabled} onClick={() => { setEditing(!editing); setKey('') }}>{editing ? 'Отменить' : 'Изменить подключение'}</button>
      <button className="text-button" disabled={disabled} onClick={() => { try { backup.disconnect(); setEditing(true); setUrl(''); setKey(''); setMessage('Отключено. История на телефоне и сервере сохранена.') } catch { setMessage('Не удалось отключить подключение. Проверь доступ к хранилищу телефона.') } }}>Отключить резервную копию</button>
    </>}
    {editing && <form className="backup-form" onSubmit={connect}>
      <label>Адрес сервера<input type="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="https://backup.example.com" required value={url} onChange={event => setUrl(event.target.value)}/></label>
      <label>Личный ключ доступа<input type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} required minLength={32} value={key} onChange={event => setKey(event.target.value)}/></label>
      <p className="gentle-note">Ключ вводится один раз и хранится только на этом телефоне. После переустановки снова понадобятся адрес и ключ.</p>
      <button className="button primary" disabled={disabled}>{working ? 'Подключаем…' : 'Подключить сервер'}</button>
    </form>}
    {message && <p className="backup-message" role="status">{message}</p>}
  </section>
}
