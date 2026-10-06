import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const testKey = 'test-only-backup-key-not-a-production-secret'
const endpoint = 'http://127.0.0.1:8788'
let server: ReturnType<typeof spawn>
let directory: string
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'home-sport-api-test-'))
  server = spawn('python3', ['server/server.py'], { env: { ...process.env, BACKUP_TOKEN: testKey, DATABASE_PATH: join(directory, 'sessions.sqlite3'), PORT: '8788', ALLOWED_ORIGIN: 'http://localhost:4173' }, stdio: 'ignore' })
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch(`${endpoint}/health`)).ok) return } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Test backup API failed to start')
})
test.afterAll(async () => {
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
  await expect(page.locator('.backup-message')).toContainText('Добавлено тренировок: 1')
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
