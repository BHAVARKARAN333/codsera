import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*packaged\.test\.(ts|js)/,
  timeout: 45000,
  expect: {
    timeout: 15000
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']]
})
