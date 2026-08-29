import { defineConfig } from '@playwright/test';

const projects = [
  {
    name: 'local',
    testMatch: /place\.spec\.mjs/,
    use: { baseURL: 'http://localhost:4173', viewport: { width: 1280, height: 800 } },
  },
];
if (process.env.LAB_URL) {
  projects.push({
    name: 'lab',
    testMatch: /smoke\.spec\.mjs/,
    use: { baseURL: process.env.LAB_URL, viewport: { width: 1280, height: 800 } },
  });
}

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  retries: 0,
  use: { trace: 'retain-on-failure' },
  reporter: [['list']],
  projects,
  webServer: {
    command: 'bash tests/fixtures/serve.sh',
    url: 'http://localhost:4173/login.html',
    reuseExistingServer: false,
    timeout: 30_000,
    cwd: new URL('../..', import.meta.url).pathname,
  },
});
