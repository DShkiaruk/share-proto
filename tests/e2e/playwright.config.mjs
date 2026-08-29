import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: process.env.LAB_URL,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
  },
  reporter: [['list']],
});
