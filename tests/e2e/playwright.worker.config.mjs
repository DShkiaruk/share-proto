import { defineConfig } from '@playwright/test';

// The same embed spec as the local run, pointed at the Cloudflare Worker
// edition instead of template/server.js. Two servers, one contract: if this
// passes, the overlay cannot tell the two backends apart.
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  use: { trace: 'retain-on-failure' },
  reporter: [['list']],
  projects: [
    {
      name: 'worker-embed',
      testMatch: /embed\.spec\.mjs/,
      use: { baseURL: 'http://localhost:4174', viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: [
    {
      command: 'bash tests/fixtures/serve-worker.sh',
      url: 'http://localhost:4173/overlay.js',
      reuseExistingServer: false,
      timeout: 90_000, // workerd downloads nothing but does compile on first boot
      cwd: new URL('../..', import.meta.url).pathname,
    },
    {
      command: 'bash tests/fixtures/serve-embed.sh',
      url: 'http://localhost:4174/embed-host.html',
      reuseExistingServer: false,
      timeout: 30_000,
      cwd: new URL('../..', import.meta.url).pathname,
    },
  ],
});
