import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests', workers: 1,
  use: { baseURL: `http://localhost:4173${process.env.VITE_BASE_PATH || '/'}`, viewport: { width: 390, height: 844 }, launchOptions: { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] }, trace: 'retain-on-failure' },
  webServer: { command: 'npm run preview -- --port 4173 --strictPort', url: `http://localhost:4173${process.env.VITE_BASE_PATH || '/'}`, reuseExistingServer: !process.env.CI },
})
