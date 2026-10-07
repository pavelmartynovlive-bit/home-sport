import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const testKey = 'test-only-backup-key-not-a-production-secret'
const endpoint = 'http://127.0.0.1:8788'
let server: ReturnType<typeof spawn>
let directory: string
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'home-sport-api-test-'))
  server = spawn('python3', ['server/server.py'], { env: { ...process.env, BACKUP_TOKEN: testKey, DATABASE_PATH: join(directory, 'sessions.sqlite3'), PORT: '8788', ALLOWED_ORIGIN: 'http://localhost:4173' }, stdio: 'ignore' })
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch(`${endpoint}/health`)).ok) return } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Test backup API failed to start')
})
test.afterEach(async () => {
  if (server && server.exitCode === null) {
    const done = new Promise(resolve => server.once('exit', resolve)); server.kill(); await done
  }
  if (directory) await rm(directory, { recursive: true, force: true })
})
test('real API: automatic backup, offline queue, retry without duplicates, reinstall restoration', async ({ page }) => {
  await page.goto('./')
  await page.getByRole('button', { name: 'Резервная копия', exact: false }).click()
  await page.getByLabel('Адрес сервера').fill(endpoint)
  await page.getByLabel('Личный ключ доступа').fill(testKey)
  await page.getByRole('button', { name: 'Подключить сервер', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Восстановить историю с сервера' })).toBeVisible()
  await page.locator('.back-link').click()
  await page.getByRole('button', { name: 'Начать тренировку' }).click()
  await page.locator('.set-check').first().click()
  // Simulate an unreachable API while local app storage remains available.
  await page.route(`${endpoint}/v1/sessions/**`, route => route.abort('connectionfailed'))
  await page.getByRole('button', { name: 'Завершить тренировку', exact: true }).click()
  await page.getByRole('button', { name: 'Завершить и сохранить' }).click()
  await expect(page.locator('.home-backup-status')).toContainText('Ожидает отправки')
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('home-sport:v1')!).history[0])
  await page.reload()
  await page.unroute(`${endpoint}/v1/sessions/**`)
  await page.getByRole('button', { name: 'Резервная копия', exact: false }).click()
  await page.getByRole('button', { name: 'Отправить копию сейчас' }).click()
  await expect(page.locator('.backup-status')).toContainText('Копия на сервере сохранена')
  await page.reload()
  const remote = await page.request.get(`${endpoint}/v1/sessions`, { headers: { Authorization: `Bearer ${testKey}` } })
  expect((await remote.json()).sessions).toEqual([saved])
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Резервная копия', exact: false }).click()
  await page.getByLabel('Адрес сервера').fill(endpoint)
  await page.getByLabel('Личный ключ доступа').fill(testKey)
  await page.getByRole('button', { name: 'Подключить сервер', exact: true }).click()
  await page.getByRole('button', { name: 'Восстановить историю с сервера' }).click()
  await expect(page.locator('.backup-message')).toContainText('Новых тренировок в копии нет')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('home-sport:v1')!).history)).toEqual([saved])
  await page.getByRole('button', { name: 'Восстановить историю с сервера' }).click()
  await expect(page.locator('.backup-message')).toContainText('Новых тренировок в копии нет')
  await page.getByRole('button', { name: 'Отключить резервную копию' }).click()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('home-sport:v1')!).history)).toEqual([saved])
})
test('wrong credentials are not saved; restoration preserves an active local workout', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto('./')
  await page.getByRole('button', { name: 'Начать тренировку' }).click()
  await page.locator('.set-check').first().click()
  const active = await page.evaluate(() => JSON.parse(localStorage.getItem('home-sport:v1')!).active)
  const remote = { ...active, id: 'restore-preserves-active-test', finishedAt: new Date().toISOString() }
  expect((await page.request.put(`${endpoint}/v1/sessions/${remote.id}`, { headers: { Authorization: `Bearer ${testKey}` }, data: remote })).ok()).toBe(true)
  await page.locator('.brand').click()
  await page.getByRole('button', { name: 'Резервная копия', exact: false }).click()
  await page.getByLabel('Адрес сервера').fill(endpoint)
  await page.getByLabel('Личный ключ доступа').fill('wrong-key-with-more-than-thirty-two-characters')
  await page.getByRole('button', { name: 'Подключить сервер', exact: true }).click()
  await expect(page.locator('.backup-message')).toContainText('Сервер не принял ключ')
  expect(await page.evaluate(() => localStorage.getItem('home-sport:backup:v1'))).toBeNull()
  await page.getByLabel('Личный ключ доступа').fill(testKey)
  await page.getByRole('button', { name: 'Подключить сервер', exact: true }).click()
  await page.getByRole('button', { name: 'Восстановить историю с сервера' }).click()
  await expect(page.locator('.backup-message')).toContainText('Текущая сессия сохранена')
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('home-sport:v1')!))
  expect(state.active).toEqual(active)
  expect(state.history.some((s: { id: string }) => s.id === remote.id)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

async function draftSession(page: import('@playwright/test').Page, id: string) {
  await page.goto('./')
  await page.getByRole('button', { name: 'Начать тренировку' }).click()
  return page.evaluate(id => {
    const active = JSON.parse(localStorage.getItem('home-sport:v1')!).active
    return { ...active, id, finishedAt: new Date().toISOString() }
  }, id)
}

test('opening a connected app restores server history and keeps connection across a new page', async ({ page, context }) => {
  const remote = await draftSession(page, 'automatic-restore-on-open')
  await page.route(`${endpoint}/v1/sessions`, route => route.fulfill({ json: { version: 1, sessions: [remote] } }))
  await page.evaluate(({ endpoint, testKey }) => {
    localStorage.setItem('home-sport:v1', JSON.stringify({ version: 1, active: null, history: [] }))
    localStorage.setItem('home-sport:backup:v1', JSON.stringify({ url: endpoint, key: testKey, savedIds: [] }))
  }, { endpoint, testKey })
  await page.reload()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('home-sport:v1')!).history.length)).toBe(1)
  const reopened = await context.newPage()
  await reopened.route(`${endpoint}/v1/sessions`, route => route.fulfill({ json: { version: 1, sessions: [remote] } }))
  await reopened.goto('./')
  await reopened.getByRole('button', { name: 'Резервная копия', exact: false }).click()
  await expect(reopened.getByRole('button', { name: 'Восстановить историю с сервера' })).toBeVisible()
  await expect(reopened.getByLabel('Адрес сервера')).toHaveCount(0)
  await reopened.close()
})

test('server missing an acknowledged session is repaired; unavailable server is not shown as saved', async ({ page }) => {
  const local = await draftSession(page, 'resend-stale-acknowledgement')
  let available = false
  await page.route(`${endpoint}/v1/sessions`, route => available ? route.fulfill({ json: { version: 1, sessions: [] } }) : route.abort('connectionfailed'))
  await page.evaluate(({ endpoint, testKey, local }) => {
    localStorage.setItem('home-sport:v1', JSON.stringify({ version: 1, active: null, history: [local] }))
    localStorage.setItem('home-sport:backup:v1', JSON.stringify({ url: endpoint, key: testKey, savedIds: [local.id] }))
  }, { endpoint, testKey, local })
  await page.reload()
  await page.getByRole('button', { name: 'Резервная копия', exact: false }).click()
  await expect(page.locator('.backup-status')).not.toContainText('Копия на сервере сохранена')
  available = true
  await page.getByRole('button', { name: 'Отправить копию сейчас' }).click()
  await expect(page.locator('.backup-status')).toContainText('Копия на сервере сохранена')
  const response = await page.request.get(`${endpoint}/v1/sessions`, { headers: { Authorization: `Bearer ${testKey}` } })
  expect((await response.json()).sessions.find((s: { id: string }) => s.id === local.id)).toEqual(local)
})

test('one conflicting workout does not block other uploads or overwrite either version', async ({ page }) => {
  const local = await draftSession(page, 'conflict-does-not-block')
  const remote = { ...local, exercises: local.exercises.map((e: { sets: unknown[] }, i: number) => i ? e : { ...e, sets: [{ reps: 1, completed: true }] }) }
  expect((await page.request.put(`${endpoint}/v1/sessions/${remote.id}`, { headers: { Authorization: `Bearer ${testKey}` }, data: remote })).ok()).toBe(true)
  const next = { ...local, id: 'upload-after-conflict' }
  await page.evaluate(({ endpoint, testKey, local, next }) => {
    localStorage.setItem('home-sport:v1', JSON.stringify({ version: 1, active: null, history: [local, next] }))
    localStorage.setItem('home-sport:backup:v1', JSON.stringify({ url: endpoint, key: testKey, savedIds: [] }))
  }, { endpoint, testKey, local, next })
  await page.reload()
  await page.getByRole('button', { name: 'Резервная копия', exact: false }).click()
  await expect(page.locator('.backup-status')).toContainText('другая версия')
  await expect.poll(async () => {
    const r = await page.request.get(`${endpoint}/v1/sessions`, { headers: { Authorization: `Bearer ${testKey}` } })
    return (await r.json()).sessions.some((s: { id: string }) => s.id === next.id)
  }).toBe(true)
  const r = await page.request.get(`${endpoint}/v1/sessions`, { headers: { Authorization: `Bearer ${testKey}` } })
  expect((await r.json()).sessions.find((s: { id: string }) => s.id === remote.id)).toEqual(remote)
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('home-sport:v1')!))
  expect(state.history.find((s: { id: string }) => s.id === local.id)).toEqual(local)
})

test('a lost response after server commit is reconciled on reopening without duplicates', async ({ page }) => {
  const local = await draftSession(page, 'lost-commit-response')
  await page.route(`${endpoint}/v1/sessions/${local.id}`, async route => {
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    await route.abort('connectionfailed')
  })
  await page.evaluate(({ endpoint, testKey, local }) => {
    localStorage.setItem('home-sport:v1', JSON.stringify({ version: 1, active: null, history: [local] }))
    localStorage.setItem('home-sport:backup:v1', JSON.stringify({ url: endpoint, key: testKey, savedIds: [] }))
  }, { endpoint, testKey, local })
  await page.reload()
  await page.getByRole('button', { name: 'Резервная копия', exact: false }).click()
  await expect(page.locator('.backup-status')).toContainText('Не удалось проверить или отправить копию')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('home-sport:backup:v1')!).savedIds.includes('lost-commit-response'))).toBe(false)
  await page.unroute(`${endpoint}/v1/sessions/${local.id}`)
  await page.reload()
  await page.getByRole('button', { name: 'Резервная копия', exact: false }).click()
  await expect(page.locator('.backup-status')).toContainText('Копия на сервере сохранена')
  const response = await page.request.get(`${endpoint}/v1/sessions`, { headers: { Authorization: `Bearer ${testKey}` } })
  expect((await response.json()).sessions.filter((s: { id: string }) => s.id === local.id)).toEqual([local])
})

test('a phone that silently refuses to store connection does not report success', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key !== 'home-sport:backup:v1') original.call(this, key, value)
    }
  })
  await page.goto('./')
  await page.getByRole('button', { name: 'Резервная копия', exact: false }).click()
  await page.getByLabel('Адрес сервера').fill(endpoint)
  await page.getByLabel('Личный ключ доступа').fill(testKey)
  await page.getByRole('button', { name: 'Подключить сервер', exact: true }).click()
  await expect(page.locator('.backup-message')).toContainText('Не удалось сохранить подключение на телефоне')
  await expect(page.getByLabel('Адрес сервера')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('home-sport:backup:v1'))).toBeNull()
})

async function connectBackup(page: import('@playwright/test').Page) {
  await page.goto('./')
  await page.getByRole('button', { name: 'Резервная копия', exact: false }).click()
  await page.getByLabel('Адрес сервера').fill(endpoint)
  await page.getByLabel('Личный ключ доступа').fill(testKey)
  await page.getByRole('button', { name: 'Подключить сервер', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Отправить копию сейчас' })).toBeEnabled()
}
async function serverDraft(page: import('@playwright/test').Page) {
  return (await page.request.get(`${endpoint}/v1/draft`, { headers: { Authorization: `Bearer ${testKey}` } })).json()
}

test('draft changes are debounced, confirmed, restored after local loss, and cleared on finish', async ({ page }) => {
  await connectBackup(page)
  await page.locator('.back-link').click()
  await page.getByRole('button', { name: 'Начать тренировку' }).click()
  await page.locator('.set-check').first().click()
  const local = await page.evaluate(() => JSON.parse(localStorage.getItem('home-sport:v1')!).active)
  // Nothing is uploaded synchronously with the edit.
  expect((await serverDraft(page)).session).toBeNull()
  await expect(page.locator('.draft-status')).toContainText('ожидают отправки')
  await expect.poll(async () => (await serverDraft(page)).session, { timeout: 10000 }).toEqual(local)
  await expect(page.locator('.draft-status')).toContainText('Текущая тренировка сохранена на сервере')
  await page.locator('.set-check').first().click()
  await page.locator('.set-check').first().click()
  await page.locator('.set-check').first().click()
  const changed = await page.evaluate(() => JSON.parse(localStorage.getItem('home-sport:v1')!).active)
  await expect.poll(async () => (await serverDraft(page)).session, { timeout: 10000 }).toEqual(changed)
  expect((await serverDraft(page)).revision).toBe(2)
  await page.evaluate(() => localStorage.removeItem('home-sport:v1'))
  await page.reload()
  await expect(page.getByRole('button', { name: 'Продолжить тренировку' })).toBeVisible()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('home-sport:v1')!).active)).toEqual(changed)
  await page.getByRole('button', { name: 'Продолжить тренировку' }).click()
  await page.getByRole('button', { name: 'Завершить тренировку', exact: true }).click()
  await page.getByRole('button', { name: 'Завершить и сохранить' }).click()
  await expect.poll(async () => (await serverDraft(page)).session).toBeNull()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Начать тренировку' })).toBeVisible()
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('home-sport:v1')!))
  expect(state.active).toBeNull()
  expect(state.history).toHaveLength(1)
})

test('offline draft edits survive reload and are sent when connectivity returns', async ({ page }) => {
  await connectBackup(page)
  await page.locator('.back-link').click()
  await page.getByRole('button', { name: 'Начать тренировку' }).click()
  await expect.poll(async () => (await serverDraft(page)).session, { timeout: 10000 }).not.toBeNull()
  await page.route(`${endpoint}/v1/draft`, route => route.abort('connectionfailed'))
  await page.locator('.set-check').first().click()
  const local = await page.evaluate(() => JSON.parse(localStorage.getItem('home-sport:v1')!).active)
  await expect(page.locator('.draft-status')).toContainText('Копию отправим', { timeout: 10000 })
  await page.reload()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('home-sport:v1')!).active)).toEqual(local)
  await page.unroute(`${endpoint}/v1/draft`)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect.poll(async () => (await serverDraft(page)).session).toEqual(local)
})

test('a lost draft acknowledgement recovers without creating another revision', async ({ page }) => {
  await connectBackup(page)
  await page.route(`${endpoint}/v1/draft`, async route => {
    if (route.request().method() !== 'PUT') { await route.continue(); return }
    expect((await route.fetch()).ok()).toBe(true)
    await route.abort('connectionfailed')
  })
  await page.locator('.back-link').click()
  await page.getByRole('button', { name: 'Начать тренировку' }).click()
  await page.locator('.set-check').first().click()
  await expect(page.locator('.draft-status')).toContainText('Копию отправим', { timeout: 10000 })
  const committed = await serverDraft(page)
  expect(committed.revision).toBe(1)
  await page.unroute(`${endpoint}/v1/draft`)
  await page.reload()
  await expect(page.locator('.draft-status')).toContainText('Текущая тренировка сохранена на сервере')
  expect(await serverDraft(page)).toEqual(committed)
})

test('a different server draft is preserved alongside an active local workout', async ({ page }) => {
  const finished = await draftSession(page, 'local-active-conflict')
  const { finishedAt: _, ...local } = finished
  const remote = { ...local, id: 'remote-active-conflict' }
  await page.evaluate(local => localStorage.setItem('home-sport:v1', JSON.stringify({ version: 1, active: local, history: [] })), local)
  expect((await page.request.put(`${endpoint}/v1/draft`, { headers: { Authorization: `Bearer ${testKey}` }, data: { version: 1, revision: 0, session: remote } })).ok()).toBe(true)
  await connectBackup(page)
  await expect(page.locator('.draft-status')).toContainText('На сервере другая текущая тренировка')
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('home-sport:v1')!))
  expect(state.active.id).toBe(local.id)
  expect((await serverDraft(page)).session).toEqual(remote)
})

test('an older VPS keeps completed backups working and shows that draft support requires update', async ({ page }) => {
  await page.route(`${endpoint}/v1/draft`, route => route.fulfill({ status: 404, json: { error: 'Not found' } }))
  await connectBackup(page)
  await expect(page.locator('.draft-status')).toContainText('нужно обновить сервер')
  await page.locator('.back-link').click()
  await page.getByRole('button', { name: 'Начать тренировку' }).click()
  await page.getByRole('button', { name: 'Завершить тренировку', exact: true }).click()
  await page.getByRole('button', { name: 'Завершить и сохранить' }).click()
  await expect(page.locator('.home-backup-status')).toContainText('Копия на сервере сохранена')
  const r = await page.request.get(`${endpoint}/v1/sessions`, { headers: { Authorization: `Bearer ${testKey}` } })
  expect((await r.json()).sessions).toHaveLength(1)
})

test('more edits after a lost draft response are uploaded without a false conflict', async ({ page }) => {
  await connectBackup(page)
  let loseResponse = true
  await page.route(`${endpoint}/v1/draft`, async route => {
    if (route.request().method() !== 'PUT' || !loseResponse) { await route.continue(); return }
    expect((await route.fetch()).ok()).toBe(true)
    await route.abort('connectionfailed')
  })
  await page.locator('.back-link').click()
  await page.getByRole('button', { name: 'Начать тренировку' }).click()
  await page.locator('.set-check').first().click()
  await expect(page.locator('.draft-status')).toContainText('Копию отправим', { timeout: 10000 })
  expect((await serverDraft(page)).revision).toBe(1)
  await page.locator('.set-check').first().click()
  const changed = await page.evaluate(() => JSON.parse(localStorage.getItem('home-sport:v1')!).active)
  loseResponse = false
  await page.reload()
  await expect(page.locator('.draft-status')).toContainText('Текущая тренировка сохранена на сервере')
  expect((await serverDraft(page)).session).toEqual(changed)
  expect((await serverDraft(page)).revision).toBe(2)
})

test('finishing while a draft upload is in flight still uploads history and prevents resurrection', async ({ page }) => {
  await connectBackup(page)
  let release!: () => void
  let started!: () => void
  const requestStarted = new Promise<void>(resolve => { started = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route(`${endpoint}/v1/draft`, async route => {
    if (route.request().method() !== 'PUT') { await route.continue(); return }
    started(); await gate; await route.continue()
  })
  await page.locator('.back-link').click()
  await page.getByRole('button', { name: 'Начать тренировку' }).click()
  await page.locator('.set-check').first().click()
  await requestStarted
  await page.getByRole('button', { name: 'Завершить тренировку', exact: true }).click()
  await page.getByRole('button', { name: 'Завершить и сохранить' }).click()
  release()
  await expect(page.locator('.home-backup-status')).toContainText('Копия на сервере сохранена')
  await expect.poll(async () => (await serverDraft(page)).session).toBeNull()
  const response = await page.request.get(`${endpoint}/v1/sessions`, { headers: { Authorization: `Bearer ${testKey}` } })
  expect((await response.json()).sessions).toHaveLength(1)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Начать тренировку' })).toBeVisible()
})
