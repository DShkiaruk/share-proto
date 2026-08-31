import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { login, mouseClick, inOverlay, apiGet, apiPost } from './helpers.mjs';

const TEAM = 'team-e2e';
const CLIENT = 'client-e2e';
test.describe.configure({ mode: 'serial' });

test('the crawler walks the fixture and posts a shot per screen', async ({ page }) => {
  const out = execFileSync('node', ['scripts/crawl.mjs', 'http://localhost:4173', '--password', TEAM, '--max-screens', '6', '--depth', '2'], {
    timeout: 150_000,
    encoding: 'utf8',
  });
  const summary = JSON.parse(out.trim().split('\n').at(-1));
  expect(summary.screens).toBeGreaterThanOrEqual(2);
  expect(summary.shots).toBeGreaterThanOrEqual(2);
  await login(page, 'Designer', TEAM);
  const d = await apiGet(page, '/api/comments');
  expect(d.shots.Home).toMatch(/^shots\//);
  expect(d.shots.Settings).toMatch(/^shots\//);
  expect(Object.keys(d.nav)).toContain('Home>Settings');
  const r = await page.request.get(`/api/file?p=${encodeURIComponent(d.shots.Settings)}`);
  expect(r.status()).toBe(200);
  expect(r.headers()['content-type']).toBe('image/jpeg');
});

test('M opens the map; a node navigates; the designer can rename and hide', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await page.mouse.click(600, 720);
  await page.keyboard.press('KeyM');
  const map = inOverlay(page, '.map');
  await expect(map).toBeVisible();
  const nodes = inOverlay(page, '.map-node');
  expect(await nodes.count()).toBeGreaterThanOrEqual(2);
  await expect(inOverlay(page, '.map-node img[src*="api/file?p=shots"]').first()).toBeVisible();
  await expect(inOverlay(page, '.map-edge')).not.toHaveCount(0);

  // rename Settings → Prefs
  const settings = nodes.filter({ hasText: 'Settings' }).first();
  await settings.locator('.map-name').dblclick();
  await inOverlay(page, '.map-rename').fill('Prefs'); // the name is replaced by the input, so the node no longer has the text
  await page.keyboard.press('Enter');
  await expect(inOverlay(page, '.map-node').filter({ hasText: 'Prefs' })).toHaveCount(1, { timeout: 10_000 });
  expect((await apiGet(page, '/api/comments')).mapmeta.aliases.Settings).toBe('Prefs');

  // click → navigate
  await mouseClick(page, inOverlay(page, '.map-node').filter({ hasText: 'Prefs' }).locator('.map-thumb'));
  await expect(map).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__fp.label()), { timeout: 10_000 }).toBe('Settings');

  // hide Home, then show it again
  await page.keyboard.press('KeyM');
  const home = inOverlay(page, '.map-node[data-label="Home"]'); // "Home · Confirm" (the dialog) is a node too
  await home.hover();
  await mouseClick(page, home.locator('.map-hide'));
  await expect(inOverlay(page, '.map-node[data-label="Home"]')).toHaveCount(0, { timeout: 10_000 });
  await mouseClick(page, inOverlay(page, '.map-toolbar .map-hidden-toggle'));
  await mouseClick(page, inOverlay(page, '.map-hidden button').filter({ hasText: /^Home — show$/ }));
  await expect(inOverlay(page, '.map-node[data-label="Home"]')).toHaveCount(1, { timeout: 10_000 });
  await page.keyboard.press('Escape');
  await expect(map).toHaveCount(0);
});

test('the client gets a read-only map — enforced by the server, not the DOM', async ({ page }) => {
  await login(page, 'Client', CLIENT);
  const jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');
  expect(await apiPost(page, { action: 'shot', label: 'Home', image: jpeg })).toBe(403);
  expect(await apiPost(page, { action: 'mapmeta', hide: 'Home' })).toBe(403);
  expect(await apiPost(page, { action: 'mapmeta', alias: { label: 'Home', name: 'Owned' } })).toBe(403);
  await page.mouse.click(600, 720);
  await page.keyboard.press('KeyM');
  await expect(inOverlay(page, '.map')).toBeVisible();
  expect(await inOverlay(page, '.map-node').count()).toBeGreaterThanOrEqual(2);
  await expect(inOverlay(page, '.map-hide')).toHaveCount(0);
  await expect(inOverlay(page, '.map-hidden-toggle')).toHaveCount(0);
});

test('a hidden screen is hidden from the client — its shot too, not just its node', async ({ page, browser }) => {
  const designer = page;
  await login(designer, 'Designer', TEAM);
  const before = await apiGet(designer, '/api/comments');
  const shotPath = before.shots.Settings;
  expect(shotPath).toMatch(/^shots\//);
  expect(await apiPost(designer, { action: 'mapmeta', hide: 'Settings' })).toBe(200);

  const client = await browser.newPage();
  await login(client, 'Client', CLIENT);
  const seen = await apiGet(client, '/api/comments');
  expect(seen.shots.Settings).toBeUndefined(); // not even the label
  expect(seen.mapmeta.hidden).toEqual([]); // nor the fact that something is hidden
  expect((await client.request.get(`/api/file?p=${encodeURIComponent(shotPath)}`)).status()).toBe(404);
  expect((await designer.request.get(`/api/file?p=${encodeURIComponent(shotPath)}`)).status()).toBe(200);

  expect(await apiPost(designer, { action: 'mapmeta', show: 'Settings' })).toBe(200);
});

// What the map has to say before anything else: where this starts, how far
// each screen is from there, and which cards are gaps rather than screens.
// Reported from the live deployment: no visible start, tangled lines, white
// cards on a white ground, and the page showing through the panel.
test('the map states where the flow begins, and stands on its own ground', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await page.mouse.click(600, 720);
  await page.keyboard.press('KeyM');
  await expect(inOverlay(page, '.map')).toBeVisible();

  // Opaque: the prototype behind it was making both unreadable.
  const alpha = await page.evaluate(() => {
    const bg = getComputedStyle(document.querySelector('[data-fp-host]').shadowRoot.querySelector('.map')).backgroundColor;
    const m = bg.match(/[\d.]+/g).map(Number);
    return m.length > 3 ? m[3] : 1;
  });
  expect(alpha).toBe(1);

  await expect(inOverlay(page, '.map-band').filter({ hasText: 'Start' }).first()).toBeVisible();
  await expect(inOverlay(page, '.map-node.start .start-flag')).toHaveCount(1);
  // labelsMatch() is loose on purpose; only one card may claim to be this screen.
  await expect(inOverlay(page, '.map-node.current')).toHaveCount(1);

  // A screen with no picture says so, and says what fills it.
  const blanks = inOverlay(page, '.map-node.blank');
  if (await blanks.count()) {
    await expect(blanks.first().locator('.map-ph-title')).toHaveText('No picture yet');
    await expect(blanks.first().locator('.map-ph-note')).toContainText('Open this screen');
  }
  await page.keyboard.press('Escape');
});

// Asked of the live deployment: "why can't I comment the map?" A comment made
// there is about the screen — you cannot point at a pixel of a screen you are
// not standing on — so it carries no anchor and no pin, and says so.
test('a screen can be commented on from the map itself', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  const before = (await apiGet(page, '/api/comments')).threads.length;
  await page.mouse.click(600, 720);
  await page.keyboard.press('KeyM');
  // By label, not by text: an earlier test renames this screen's card.
  const card = inOverlay(page, '.map-node[data-label="Settings"]');
  await expect(card).toBeVisible();
  await mouseClick(page, card.locator('.map-act').filter({ hasText: 'Comment' }));
  const ta = card.locator('.compose textarea');
  await expect(ta).toBeVisible();
  await ta.fill('this screen does not belong in the flow');
  await page.keyboard.press('Enter');

  await expect
    .poll(async () => (await apiGet(page, '/api/comments')).threads.length, { timeout: 15_000 })
    .toBe(before + 1);
  const d = await apiGet(page, '/api/comments');
  const made = d.threads.find((t) => t.messages[0].text.startsWith('this screen does not belong'));
  expect(made.screenLabel).toBe('Settings');
  expect(made.anchor, 'about the screen, not a spot on it').toBeNull();

  // No pin anywhere, and the sidebar says why.
  await page.keyboard.press('Escape');
  await expect(inOverlay(page, '.map')).toHaveCount(0);
  await mouseClick(page, inOverlay(page, '.tb-btn').nth(1));
  const row = inOverlay(page, '.sb-row').filter({ hasText: 'this screen does not belong' });
  await expect(row.locator('.badge').filter({ hasText: 'Screen' })).toBeVisible();
  await mouseClick(page, row);
  await expect(inOverlay(page, '.popover .badge').filter({ hasText: 'About this screen' })).toBeVisible({ timeout: 15_000 });
  const pinned = await page.evaluate(
    (n) =>
      [...document.querySelector('[data-fp-host]').shadowRoot.querySelectorAll('.pin')].some(
        (p) => p.textContent.trim() === String(n) && p.style.display !== 'none'
      ),
    made.n
  );
  expect(pinned, 'a comment about the screen has no spot to pin').toBe(false);
  await page.keyboard.press('Escape');
});

// Asked of the live deployment: "I don't want No picture at all — why can't we
// add one?" A designer can, from the card.
test('a screen with no picture can be given one from its card', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await apiPost(page, { action: 'edge', from: 'Home', to: 'Nowhere yet', anchor: { path: 'body', t: 'button', txt: 'Nowhere' } });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__fp?.state.role));
  await page.mouse.click(600, 720);
  await page.keyboard.press('KeyM');
  const blank = inOverlay(page, '.map-node.blank[data-label="Nowhere yet"]');
  await expect(blank).toBeVisible();
  await expect(blank.locator('.map-ph-title')).toHaveText('No picture yet');

  await blank.locator('input[type="file"]').setInputFiles('tests/fixtures/pixel.png');
  await expect
    .poll(async () => Object.keys((await apiGet(page, '/api/comments')).shots), { timeout: 20_000 })
    .toContain('Nowhere yet');
  await expect(inOverlay(page, '.map-node[data-label="Nowhere yet"] img')).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape');
});

// Reported: clicking a comment whose element is gone opened the card in the
// top-left corner, over the sidebar. A hidden pin measures 0×0 at the origin,
// and that was being used as its position.
test('a comment whose element is gone opens where it can be read, not in the corner', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  const res = await page.evaluate(async () => {
    const r = await fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'create',
        text: 'left on something that no longer exists',
        screen: 'Home',
        screenLabel: 'Home',
        anchor: { path: 'div#gone > span:nth-of-type(9)', t: 'span', txt: 'Preview', fx: 0.9, fy: 0.31 },
      }),
    });
    return (await r.json()).thread;
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__fp?.state.role));
  await page.waitForTimeout(500);

  // No pin: its element is not on the page and nothing reopens it.
  const stranded = await page.evaluate(
    (n) =>
      [...document.querySelector('[data-fp-host]').shadowRoot.querySelectorAll('.pin')].some(
        (p) => p.textContent.trim() === String(n) && p.style.display !== 'none'
      ),
    res.n
  );
  expect(stranded, 'no pin over content the comment was never about').toBe(false);

  await mouseClick(page, inOverlay(page, '.tb-btn').nth(1));
  await mouseClick(page, inOverlay(page, '.sb-row').filter({ hasText: 'no longer exists' }).first());
  const pop = inOverlay(page, '.popover');
  await expect(pop).toBeVisible({ timeout: 15_000 });
  const box = await pop.boundingBox();
  expect(box.x, 'not pinned to the origin').toBeGreaterThan(24);
  expect(box.y).toBeGreaterThan(24);
  expect(box.x + box.width).toBeLessThanOrEqual(1280);

  await page.evaluate(
    (id) => fetch('/api/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', threadId: id }) }),
    res.id
  );
});
