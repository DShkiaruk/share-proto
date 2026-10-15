import { test, expect } from '@playwright/test';
import { login, mouseClick, inOverlay, apiPost, asOlderServer } from './helpers.mjs';

const TEAM = 'team-e2e';

/* What the tool costs to keep running. A reviewer leaving the prototype open
   is the normal case, and on a free storage tier every poll is charged: a fixed
   25 s costs about a thousand reads in a working day, nearly all of them
   learning that nothing changed. These tests hold the two properties that make
   backing off safe — it does back off, and it comes straight back. */
test.describe.configure({ mode: 'serial' });

/* ---------- a server that can say what changed (lib/changes.js) ---------- */

// Every GET /api/comments a page makes, from here on.
function countReads(page) {
  const reads = [];
  const asks = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname === '/api/comments' && r.method() === 'GET') reads.push(u.href);
    if (u.pathname === '/api/version') asks.push(u.href);
  });
  return { reads, asks };
}

test('asking whether anything changed costs no read while nothing has', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  expect(await page.evaluate(() => window.__fp.changes)).toBe('/api/version');
  const seen = countReads(page);
  for (let i = 0; i < 5; i++) await page.evaluate(() => window.__fp.ask());
  expect(seen.asks.length).toBe(5);
  expect(seen.reads.length).toBe(0);
});

test('a change is read once, and asking is quiet again after it', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  const seen = countReads(page);
  expect(
    await apiPost(page, { action: 'create', text: 'budget: read once', screen: 'Home', screenLabel: 'Home' })
  ).toBe(200);
  await page.evaluate(() => window.__fp.ask());
  expect(seen.reads.length).toBe(1);
  expect(await page.evaluate(() => window.__fp.state.threads.some((t) => t.messages[0].text === 'budget: read once'))).toBe(true);
  for (let i = 0; i < 3; i++) await page.evaluate(() => window.__fp.ask());
  expect(seen.reads.length).toBe(1);
});

test('a click asks, and a burst of clicks asks once', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await page.waitForTimeout(3200); // past the at-most-every-3-s window of the first read
  const before = await page.evaluate(() => window.__fp.asks);
  for (let i = 0; i < 5; i++) await page.mouse.click(400 + i * 10, 300);
  expect(await page.evaluate(() => window.__fp.asks)).toBe(before + 1);
});

test('someone else’s comment shows on the reader’s next click, not on the next poll', async ({ page, browser }) => {
  await login(page, 'Designer', TEAM);
  await page.evaluate(() => window.__fp.schedule(10 * 60 * 1000)); // no poll will come
  await page.waitForTimeout(3200);
  const other = await browser.newPage({ baseURL: 'http://localhost:4173', viewport: { width: 1280, height: 800 } });
  await login(other, 'Olena', 'client-e2e');
  expect(
    await apiPost(other, { action: 'create', text: 'budget: seen on click', screen: 'Home', screenLabel: 'Home' })
  ).toBe(200);
  await other.close();
  await page.mouse.click(400, 300);
  await expect
    .poll(() => page.evaluate(() => window.__fp.state.threads.some((t) => t.messages[0].text === 'budget: seen on click')), { timeout: 2000 })
    .toBe(true);
});

test('an endpoint that keeps failing is given up, and reading takes over', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await page.route('**/api/version*', (route) => route.fulfill({ status: 500, body: '{}' }));
  const seen = countReads(page);
  for (let i = 0; i < 3; i++) await page.evaluate(() => window.__fp.ask());
  // each failed ask reads in full, so nothing is missed meanwhile
  expect(seen.reads.length).toBe(3);
  expect(await page.evaluate(() => window.__fp.changes)).toBe(null);
  await page.evaluate(() => window.__fp.ask());
  expect(seen.asks.length).toBe(3);
});

/* ---------- an older server: every poll is a full read ---------- */

test('a quiet room is polled less and less', async ({ page }) => {
  await asOlderServer(page);
  await login(page, 'Designer', TEAM);
  const pace = () => page.evaluate(() => window.__fp.pollEvery);
  expect(await pace()).toBe(25000);

  // Four reads with nothing happening in between.
  await page.evaluate(async () => {
    for (let i = 0; i < 4; i++) await window.__fp.refresh();
  });
  const eased = await pace();
  expect(eased).toBeGreaterThan(25000);
  expect(eased).toBeLessThanOrEqual(4 * 60 * 1000);

  // ...and it never drifts past the cap, however long the quiet lasts.
  await page.evaluate(async () => {
    for (let i = 0; i < 20; i++) await window.__fp.refresh();
  });
  expect(await pace()).toBe(4 * 60 * 1000);
});

test('anything actually happening brings it straight back', async ({ page }) => {
  await asOlderServer(page);
  await login(page, 'Designer', TEAM);
  await page.evaluate(async () => {
    for (let i = 0; i < 6; i++) await window.__fp.refresh();
  });
  expect(await page.evaluate(() => window.__fp.pollEvery)).toBeGreaterThan(25000);

  // Someone else posts, and the next read finds it.
  expect(
    await apiPost(page, { action: 'create', text: 'budget: someone said something', screen: 'Home', screenLabel: 'Home' })
  ).toBe(200);
  await page.evaluate(() => window.__fp.refresh());
  expect(await page.evaluate(() => window.__fp.pollEvery)).toBe(25000);

  // A change is not only re-paced, it is shown.
  await mouseClick(page, inOverlay(page, '.tb-btn').nth(1));
  await expect(inOverlay(page, '.sb-row').filter({ hasText: 'budget: someone said' })).toBeVisible();

  // Touching the page counts as being present, too.
  await page.evaluate(async () => {
    for (let i = 0; i < 4; i++) await window.__fp.refresh();
  });
  expect(await page.evaluate(() => window.__fp.pollEvery)).toBeGreaterThan(25000);
  await page.mouse.click(400, 300);
  expect(await page.evaluate(() => window.__fp.pollEvery)).toBe(25000);
});

test('a comment and its picture cost one upload, not two', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  const before = await page.evaluate(async () => (await (await fetch('/api/comments')).json()).shots);
  await mouseClick(page, inOverlay(page, '.tb-btn').first()); // Comment
  await page.mouse.click(500, 300);
  const ta = inOverlay(page, '.popover textarea');
  await expect(ta).toBeVisible();
  await ta.fill('budget: the picture does double duty');
  await page.keyboard.press('Enter');

  const thread = await expect
    .poll(
      async () => {
        const d = await page.evaluate(async () => (await (await fetch('/api/comments')).json()));
        return d.threads.find((t) => t.messages[0].text.startsWith('budget: the picture'))?.preview || null;
      },
      { timeout: 15_000 }
    )
    .not.toBeNull()
    .then(() =>
      page.evaluate(async () => {
        const d = await (await fetch('/api/comments')).json();
        const t = d.threads.find((x) => x.messages[0].text.startsWith('budget: the picture'));
        return { preview: t.preview, shots: d.shots };
      })
    );

  // The screen had no picture, so the comment's preview became the screen's own
  // — one stored object serving both, and reachable through the media endpoint.
  if (!before.Home) {
    expect(thread.preview).toBe(thread.shots.Home);
    expect(thread.preview.startsWith('shots/')).toBe(true);
  }
  const status = await page.evaluate(
    async (p) => (await fetch(`/api/file?p=${encodeURIComponent(p)}`)).status,
    thread.preview
  );
  expect(status).toBe(200);
});
