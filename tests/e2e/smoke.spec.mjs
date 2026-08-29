import { test, expect } from '@playwright/test';
import { login, mouseClick, inOverlay, apiGet } from './helpers.mjs';

const TEAM = process.env.LAB_TEAM;
const CLIENT = process.env.LAB_CLIENT;
const stamp = `e2e ${Date.now()}`;

test('designer leaves a comment with real clicks; client cannot see it', async ({ browser }) => {
  const designer = await browser.newPage();
  await login(designer, 'E2E Designer', TEAM);

  // Enter comment mode with the hotkey, click a visible heading, type, send.
  await designer.keyboard.press('KeyC');
  const heading = designer.locator('h1, h2, h3').filter({ visible: true }).first();
  await mouseClick(designer, heading);
  const ta = inOverlay(designer, '.popover textarea');
  await expect(ta).toBeVisible();
  await ta.fill(stamp);
  await designer.keyboard.press('Enter');
  await expect(inOverlay(designer, '.popover .msg .text').filter({ hasText: stamp })).toBeVisible({ timeout: 15_000 });

  const mine = await apiGet(designer, '/api/comments');
  const created = mine.threads.find((t) => t.messages[0]?.text === stamp);
  expect(created).toBeTruthy();
  expect(created.authorRole).toBe('designer');

  const client = await browser.newPage();
  await login(client, 'E2E Client', CLIENT);
  const theirs = await apiGet(client, '/api/comments');
  expect(theirs.threads.some((t) => t.id === created.id)).toBe(false);

  // Client cannot fetch a (hypothetical) preview of a designer thread.
  const status = await client.evaluate(
    async (id) => (await fetch(`/api/file?p=previews/${id}/x.jpg`)).status,
    created.id
  );
  expect(status).toBe(404);

  // Cleanup.
  await designer.evaluate(
    async (id) =>
      fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', threadId: id }),
      }),
    created.id
  );
});

test('unauthenticated API calls are rejected', async ({ request }) => {
  for (const p of ['/api/comments', '/api/file?p=shots/a/b.jpg']) {
    const r = await request.get(`${process.env.LAB_URL}${p}`);
    expect(r.status()).toBe(401);
  }
});
