import { defineConfig, devices } from '@playwright/test';

// 실행 전: `npm run build && npx vite preview --port 4173` 와 `npm run server` 를 띄운다.
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:4173',
    headless: true,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
