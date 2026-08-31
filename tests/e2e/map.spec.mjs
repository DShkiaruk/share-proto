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
