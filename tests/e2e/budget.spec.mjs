import { test, expect } from '@playwright/test';
import { login, mouseClick, inOverlay, apiPost } from './helpers.mjs';

const TEAM = 'team-e2e';

/* What the tool costs to keep running. A reviewer leaving the prototype open
   is the normal case, and on a free storage tier every poll is charged: a fixed
   25 s costs about a thousand reads in a working day, nearly all of them
   learning that nothing changed. These tests hold the two properties that make
   backing off safe — it does back off, and it comes straight back. */
test.describe.configure({ mode: 'serial' });

test('a quiet room is polled less and less', async ({ page }) => {
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
