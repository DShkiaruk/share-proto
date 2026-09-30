import { test, expect } from '@playwright/test';
import { login, mouseClick, inOverlay, apiGet, apiPost, openList, settledBox } from './helpers.mjs';

/* A screen was deleted from the prototype and its comments stayed behind.
   Reported from a live review: opening such a comment sent the prototype
   walking through every screen on its own and reloading forever, and the
   comment could be neither closed nor deleted — its card only ever opens at
   the end of a walk that never ended. The fixture (tests/fixtures/removed.html)
   is that prototype the day after: the graph still knows two ways into
   "Change flight", and both now lead to a screen it has never seen. */

const TEAM = 'team-e2e';
const CLIENT = 'client-e2e';

const anchor = (txt) => ({ path: 'main > nope', t: 'button', txt });
const EDGES = [
  ['Trip', 'Flight', 'Flight'],
  ['Trip', 'Seats', 'Seats'],
  ['Flight', 'Trip', 'Back'],
  ['Seats', 'Trip', 'Back'],
  ['Flight', 'Change flight', 'Change flight'],
  ['Seats', 'Change flight', 'Pick another flight'],
];

const threadsOf = async (page) => (await apiGet(page, '/api/comments')).threads;
const threadOf = async (page, id) => (await threadsOf(page)).find((x) => x.id === id);
const label = (page) => page.evaluate(() => window.__fp.label());
const card = (page) => inOverlay(page, '.popover');
const rowOf = (page, text) => inOverlay(page, '.sb-row').filter({ hasText: text });

async function seedGraph(page) {
  for (const [from, to, txt] of EDGES) await apiPost(page, { action: 'edge', from, to, anchor: anchor(txt) });
}

async function comment(page, text, extra = {}) {
  return page.evaluate(
    async (b) =>
      (
        await (
          await fetch('/api/comments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(b),
          })
        ).json()
      ).thread,
    {
      action: 'create',
      text,
      screenLabel: 'Change flight',
      page: '/',
      anchor: { path: 'main > gone', t: 'button', txt: 'Select flight', fx: 0.5, fy: 0.3 },
      ...extra,
    }
  );
}

// The build the overlay is looking at — marks are scoped to it.
const currentProto = async (page) => {
  await page.waitForFunction(() => Boolean(window.__fp?.state.proto), null, { timeout: 10_000 });
  return page.evaluate(() => window.__fp.state.proto);
};

// Reload so the overlay reads what was seeded, then let its boot finish (it
// learns the start screen 1.2 s in — a person never clicks sooner than that).
async function ready(page) {
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__fp?.state.threads?.length), null, { timeout: 15_000 });
  await page.waitForTimeout(1500);
}

async function clickRow(page, text) {
  await openList(page);
  const box = await settledBox(rowOf(page, text));
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

// Each test starts from an empty room, so no count leaks between them.
test.afterEach(async ({ page }) => {
  try {
    for (const t of await threadsOf(page)) await apiPost(page, { action: 'delete', threadId: t.id });
  } catch {
    /* the page may be signed out or mid-navigation; the next login starts clean anyway */
  }
});

test('a comment on a deleted screen stops after one reload and opens as not found', async ({ page }) => {
  await login(page, 'Tamara', TEAM);
  await seedGraph(page);
  const t = await comment(page, 'how does it look before a flight is picked?');
  // Another comment on the same screen: the fact is about the screen, so it
  // gets the note too — that is what lets the designer close them together.
  const sibling = await comment(page, 'and the price column on the same screen');
  const elsewhere = await comment(page, 'a comment on a screen that exists', { screenLabel: 'Seats' });
  await ready(page);
  let loads = 0;
  page.on('load', () => loads++);

  await clickRow(page, 'before a flight is picked');
  await expect(card(page).locator('.missing-note')).toBeVisible({ timeout: 30_000 });
  expect(loads).toBeLessThanOrEqual(1);
  await expect(card(page)).toContainText('Change flight');

  // And it stays put: no walk resumes, no reload comes later.
  const here = await label(page);
  await page.waitForTimeout(6000);
  expect(loads).toBeLessThanOrEqual(1);
  expect(await label(page)).toBe(here);

  // The note is shared, and scoped to the build that did not have the screen.
  const saved = await threadOf(page, t.id);
  expect(saved.missing?.proto).toBe(await currentProto(page));
  expect(saved.status).toBe('open');
  await expect.poll(async () => (await threadOf(page, sibling.id)).missing?.proto ?? null).toBe(saved.missing.proto);
  expect((await threadOf(page, elsewhere.id)).missing ?? null).toBe(null);
});

test('a comment already marked not found opens in place, and Try again walks', async ({ page }) => {
  await login(page, 'Tamara', TEAM);
  await seedGraph(page);
  const t = await comment(page, 'marked before you came');
  await apiPost(page, { action: 'missing', threadId: t.id, missing: true, proto: await currentProto(page) });
  await ready(page);

  await openList(page);
  await expect(rowOf(page, 'marked before you came')).toContainText('Screen not found');
  await clickRow(page, 'marked before you came');
  await expect(card(page).locator('.missing-note')).toBeVisible({ timeout: 2000 });
  // No walk: the prototype has not moved.
  await page.waitForTimeout(1500);
  expect(await label(page)).toBe('Trip');

  // The reader who thinks the screen is still there can ask again.
  await mouseClick(page, card(page).locator('.missing-note button', { hasText: 'Try again' }));
  await expect.poll(() => label(page), { timeout: 5000 }).not.toBe('Trip');
  await page.keyboard.press('Escape'); // stop it; the next test starts clean
});

test('a mark from an older build does not count in this one', async ({ page }) => {
  await login(page, 'Tamara', TEAM);
  await seedGraph(page);
  const t = await comment(page, 'the screen came back since');
  await apiPost(page, { action: 'missing', threadId: t.id, missing: true, proto: 'an-older-build' });
  await ready(page);
  await openList(page);
  await expect(rowOf(page, 'the screen came back since')).not.toContainText('Screen not found');
});

test('the designer closes a not-found comment as removed from its card', async ({ page }) => {
  await login(page, 'Tamara', TEAM);
  const t = await comment(page, 'close me, designer');
  await apiPost(page, { action: 'missing', threadId: t.id, missing: true, proto: await currentProto(page) });
  await ready(page);
  await clickRow(page, 'close me, designer');
  await mouseClick(page, card(page).locator('.missing-note button', { hasText: 'screen removed' }));
  await expect.poll(async () => (await threadOf(page, t.id)).status).toBe('wont');
  expect((await threadOf(page, t.id)).statusNote).toBe('Screen removed');
});

test('a client closes a not-found comment of their own as done', async ({ page }) => {
  await login(page, 'Olena', CLIENT);
  const t = await comment(page, 'close me, client');
  await apiPost(page, { action: 'missing', threadId: t.id, missing: true, proto: await currentProto(page) });
  await ready(page);
  await clickRow(page, 'close me, client');
  await mouseClick(page, card(page).locator('.missing-note button', { hasText: 'Mark done' }));
  await expect.poll(async () => (await threadOf(page, t.id)).status).toBe('done');
});

test('the designer closes every not-found comment at once, and nothing else', async ({ page }) => {
  await login(page, 'Tamara', TEAM);
  const proto = await currentProto(page);
  const a = await comment(page, 'gone one');
  const b = await comment(page, 'gone two');
  const keep = await comment(page, 'still here', { screenLabel: 'Seats' });
  for (const x of [a, b]) await apiPost(page, { action: 'missing', threadId: x.id, missing: true, proto });
  await ready(page);
  await openList(page);
  const banner = inOverlay(page, '.sb-missing');
  await expect(banner).toContainText('2 comments');
  const close = banner.locator('button');
  await mouseClick(page, close);
  // Two steps: the first click only asks.
  await expect(close).toContainText('Close 2?');
  expect((await threadOf(page, a.id)).status).toBe('open');
  await mouseClick(page, close);
  await expect.poll(async () => (await threadOf(page, a.id)).status).toBe('wont');
  await expect.poll(async () => (await threadOf(page, b.id)).status).toBe('wont');
  expect((await threadOf(page, b.id)).statusNote).toBe('Screen removed');
  expect((await threadOf(page, keep.id)).status).toBe('open');
  await expect(banner).toHaveCount(0);
});

test('the client sees no bulk close', async ({ page }) => {
  await login(page, 'Olena', CLIENT);
  const t = await comment(page, 'client gone');
  await apiPost(page, { action: 'missing', threadId: t.id, missing: true, proto: await currentProto(page) });
  await ready(page);
  await openList(page);
  await expect(rowOf(page, 'client gone')).toContainText('Screen not found');
  await expect(inOverlay(page, '.sb-missing')).toHaveCount(0);
});

test('landing on the screen clears the mark', async ({ page }) => {
  await login(page, 'Tamara', TEAM);
  const t = await comment(page, 'it was here all along', { screenLabel: 'Seats', anchor: null });
  await apiPost(page, { action: 'missing', threadId: t.id, missing: true, proto: await currentProto(page) });
  await ready(page);
  await mouseClick(page, page.locator('#app button', { hasText: 'Seats' }));
  await expect.poll(async () => (await threadOf(page, t.id)).missing ?? null, { timeout: 5000 }).toBe(null);
});

test('Esc stops a walk and opens the comment where it can be read', async ({ page }) => {
  await login(page, 'Tamara', TEAM);
  await seedGraph(page);
  const t = await comment(page, 'stop walking');
  await ready(page);
  let loads = 0;
  page.on('load', () => loads++);
  await clickRow(page, 'stop walking');
  // The first way in now lands on the new screen, where the walk waits to see
  // whether it arrived. Stop it there.
  await expect.poll(() => label(page), { timeout: 5000 }).toBe('Flight options');
  await page.keyboard.press('Escape');
  await expect(inOverlay(page, '.toast.sticky')).toHaveCount(0);
  await expect(card(page)).toBeVisible();
  await page.waitForTimeout(7000);
  expect(loads).toBe(0);
  expect(await label(page)).toBe('Flight options');
  // Stopping is not evidence the screen is gone.
  expect((await threadOf(page, t.id)).missing ?? null).toBe(null);
});

test('a comment on a page removed from the build opens as not found, without leaving', async ({ page }) => {
  await login(page, 'Tamara', TEAM);
  await comment(page, 'the old pricing page', { page: '/pricing.html', screenLabel: 'Pricing' });
  await ready(page);
  let loads = 0;
  page.on('load', () => loads++);
  await clickRow(page, 'the old pricing page');
  await expect(card(page).locator('.missing-note')).toBeVisible({ timeout: 5000 });
  expect(loads).toBe(0);
  expect(await page.evaluate(() => location.pathname)).toBe('/');
});

// Guard, not a new behaviour: a screen the graph has never heard of is not
// evidence of anything. The reader is still asked to go there by hand.
test('a comment whose way is simply unknown is not marked not found', async ({ page }) => {
  await login(page, 'Tamara', TEAM);
  await seedGraph(page);
  const t = await comment(page, 'somewhere nobody walked yet', { screenLabel: 'Nowhere yet' });
  await ready(page);
  await clickRow(page, 'somewhere nobody walked yet');
  await expect(inOverlay(page, '.toast.sticky')).toContainText('Navigate to');
  await page.waitForTimeout(1000);
  expect((await threadOf(page, t.id)).missing ?? null).toBe(null);
});
