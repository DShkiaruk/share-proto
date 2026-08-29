import { defineConfig } from '@playwright/test';

// Local projects share one fixture server (webServer below) and therefore one
// comment store: they run in a fixed order, one worker, so counts and numbers
// asserted by an earlier spec are not disturbed by a later one.
const local = { baseURL: 'http://localhost:4173', viewport: { width: 1280, height: 800 } };
const projects = [
  { name: 'local-place', testMatch: /place\.spec\.mjs/, use: local },
  { name: 'local-media', testMatch: /media\.spec\.mjs/, use: local, dependencies: ['local-place'] },
  { name: 'local-workflow', testMatch: /workflow\.spec\.mjs/, use: local, dependencies: ['local-media'] },
  { name: 'local-map', testMatch: /map\.spec\.mjs/, use: local, dependencies: ['local-workflow'] },
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
  workers: 1,
  fullyParallel: false,
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
