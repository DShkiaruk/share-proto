import { test, expect } from '@playwright/test';
import { requireEnv, login, mouseClick, inOverlay, apiGet, apiPost } from './helpers.mjs';

requireEnv();
const TEAM = process.env.LAB_TEAM;
const CLIENT = process.env.LAB_CLIENT;
const stamp = `e2e ${Date.now()}`;

test('designer leaves a comment with real clicks; client cannot see it', async ({ browser }) => {
  const designer = await browser.newPage();
  await login(designer, 'E2E Designer', TEAM);
  let createdId = null;
  try {
    // Enter comment mode via the toolbar button (the prototype autofocuses its
    // search box, which makes the C hotkey a race), then click a visible heading.
    await mouseClick(designer, inOverlay(designer, '.tb-btn').first());
    await expect(inOverlay(designer, '.click-layer')).toBeVisible();
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
    createdId = created.id;
    expect(created.authorRole).toBe('designer');

    const client = await browser.newPage();
    await login(client, 'E2E Client', CLIENT);
    const theirs = await apiGet(client, '/api/comments');
    expect(theirs.threads.some((t) => t.id === created.id)).toBe(false);

    // Client cannot fetch a (hypothetical) preview of a designer thread, nor reply to it.
    const status = await client.evaluate(
      async (id) => (await fetch(`/api/file?p=previews/${id}/x.jpg`)).status,
      created.id
    );
    expect(status).toBe(404);
    expect(await apiPost(client, { action: 'reply', threadId: created.id, text: 'x' })).toBe(404);
  } finally {
    if (createdId) await apiPost(designer, { action: 'delete', threadId: createdId });
  }
});

test('unauthenticated API calls are rejected', async ({ request }) => {
  for (const p of ['/api/comments', '/api/file?p=shots/a/b.jpg']) {
    const r = await request.get(`${process.env.LAB_URL}${p}`);
    expect(r.status()).toBe(401);
  }
});

test('mutations take the fast path (no rebuild) and polls are uncacheable', async ({ request }) => {
  const login = await request.post(`${process.env.LAB_URL}/api/login`, {
    data: { name: 'E2E Path', password: TEAM },
  });
  expect(login.status()).toBe(200);
  const poll = await request.get(`${process.env.LAB_URL}/api/comments`);
  expect(poll.headers()['cache-control']).toBe('no-store');
  expect(poll.headers()['x-store-path']).toBe('read');
  const created = await request.post(`${process.env.LAB_URL}/api/comments`, {
    data: { action: 'create', text: `${stamp} path`, screen: 'e2e', screenLabel: 'e2e', anchor: { path: 'body' } },
  });
  expect(created.status()).toBe(200);
  expect(created.headers()['x-store-path']).toBe('patch');
  const { thread } = await created.json();
  const del = await request.post(`${process.env.LAB_URL}/api/comments`, {
    data: { action: 'delete', threadId: thread.id },
  });
  expect(del.status()).toBe(200);
});
