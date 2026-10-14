import { defineConfig } from '@playwright/test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  testDir: here,
  testMatch: 'e2e.test.ts',
  outputDir: process.env.GRADE_OUTPUT ?? 'test-results',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 20_000,
  globalTimeout: 90_000,
  reporter: process.env.GRADE_JSON ? [['json', { outputFile: process.env.GRADE_JSON }]] : 'list',
  use: {
    baseURL: process.env.BASE_URL,
    headless: true,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },
})
