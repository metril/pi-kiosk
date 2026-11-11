import { defineConfig } from '@playwright/test'

// CHROME_PATH: optional chromium binary (when the bundled revision is not installed).
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  timeout: 120_000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 800, height: 480 },
    hasTouch: true,
    launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
  },
  webServer: { command: 'npm run build && npx vite preview --host 127.0.0.1 --port 4173 --strictPort', url: 'http://127.0.0.1:4173', reuseExistingServer: true, timeout: 120_000 },
})
