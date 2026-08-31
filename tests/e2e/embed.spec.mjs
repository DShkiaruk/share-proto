// Embed mode: the overlay dropped onto someone else's deployment (a PR
// preview). No cookie survives cross-site, so auth is a bearer token from an
// in-overlay login modal, comments live in a room, and media is fetched with
// the header and shown as a blob: URL — never with the token in a URL.
import { test, expect } from '@playwright/test';
import { mouseClick, inOverlay } from './helpers.mjs';

const HOST = 'http://localhost:4174/embed-host.html';
const API = 'http://localhost:4173';
const TEAM = 'team-e2e';
test.describe.configure({ mode: 'serial' });

async function signIn(page, name = 'Embed Designer', pass = TEAM) {
  await page.goto(HOST);
  const card = inOverlay(page, '.login-card');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await inOverlay(page, '.login-input').first().fill(name);
  await inOverlay(page, '.login-input').nth(1).fill(pass);
  await mouseClick(page, inOverlay(page, '.login-btn:not(.secondary)')); // "Not now" is the first button in the row
  await expect(card).toHaveCount(0, { timeout: 15_000 });
  await expect(inOverlay(page, '.toolbar')).toBeVisible();
}
const roomThreads = (page, room) =>
  page.evaluate(
    async ([api, r]) => {
      const token = localStorage.getItem(`fp_token::${api}`);
      const res = await fetch(`${api}/api/comments${r ? `?room=${r}` : ''}`, { headers: { Authorization: `Bearer ${token}` } });
      return (await res.json()).threads;
    },
    [API, room]
  );

test('an unsigned-in visitor is not blocked by the overlay and can dismiss it', async ({ page }) => {
  await page.goto(HOST);
  await expect(inOverlay(page, '.login-card')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#pay')).toBeVisible(); // the host page still works behind the modal
  await mouseClick(page, inOverlay(page, '.login-close'));
  await expect(inOverlay(page, '.login-card')).toHaveCount(0);
  await expect(inOverlay(page, '.login-pill')).toBeVisible(); // quiet way back in
  await page.reload();
  await expect(inOverlay(page, '.login-pill')).toBeVisible({ timeout: 15_000 }); // dismissal sticks for the session
  await expect(inOverlay(page, '.login-card')).toHaveCount(0);
});

test('a comment made in the embed lands in its room, not in the host prototype', async ({ page }) => {
  await signIn(page);
  await mouseClick(page, inOverlay(page, '.tb-btn').first()); // Comment
  await expect(inOverlay(page, '.click-layer')).toBeVisible();
  await mouseClick(page, page.locator('#pay'));
  const ta = inOverlay(page, '.popover textarea');
  await expect(ta).toBeVisible();
  await ta.fill('embed: the pay button needs a loading state');
  await page.keyboard.press('Enter');
  await expect(inOverlay(page, '.popover .msg .text').filter({ hasText: 'embed:' })).toBeVisible({ timeout: 15_000 });

  const inRoom = await roomThreads(page, 'pr-7');
  const created = inRoom.find((t) => t.messages[0].text.startsWith('embed:'));
  expect(created).toBeTruthy();
  expect(created.screenLabel).toBe('Checkout');
  const defaultRoom = await roomThreads(page, null);
  expect(defaultRoom.some((t) => t.messages[0].text.startsWith('embed:'))).toBe(false);
});

test('media loads through the bearer header as a blob: URL, never with a token in the URL', async ({ page }) => {
  await signIn(page);
  await mouseClick(page, inOverlay(page, '.tb-btn').first());
  await mouseClick(page, page.locator('h1'));
  await inOverlay(page, '.attach-input').setInputFiles('tests/fixtures/pixel.png');
  await expect(inOverlay(page, '.attach-strip .thumb')).toHaveCount(1);
  await inOverlay(page, '.popover textarea').fill('embed: see attached');
  await page.keyboard.press('Enter');
  const img = inOverlay(page, '.popover .msg .imgs img');
  await expect(img).toBeVisible({ timeout: 15_000 });
  await expect(img).toHaveAttribute('src', /^blob:/);
  expect(await img.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0); // it actually decoded

  // The removed `?token=` shortcut must stay removed.
  const status = await page.evaluate(
    async ([api]) => {
      const token = localStorage.getItem(`fp_token::${api}`);
      const r = await fetch(`${api}/api/file?p=attach/x/y.jpg&room=pr-7&token=${encodeURIComponent(token)}`);
      return r.status;
    },
    [API]
  );
  expect(status).toBe(401);
});

test('the API refuses a browser on an origin that is not allow-listed', async ({ page }) => {
  await signIn(page);
  const token = await page.evaluate(([api]) => localStorage.getItem(`fp_token::${api}`), [API]);
  await page.goto('http://127.0.0.1:4174/embed-host.html'); // same content, different origin
  const blocked = await page.evaluate(
    async ([api, t]) => {
      try {
        await fetch(`${api}/api/comments?room=pr-7`, { headers: { Authorization: `Bearer ${t}` } });
        return 'allowed';
      } catch (e) {
        return 'blocked';
      }
    },
    [API, token]
  );
  expect(blocked).toBe('blocked');
});
