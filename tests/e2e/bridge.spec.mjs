// The shape the runbook recommends: the page behind this tool's own gate, the
// comments on another host. Everything here only exists when those two are
// apart, and none of it was covered — which is why a designer was the one who
// found that the same password was asked for twice, and then that two ways to
// comment were on screen at once.
import { test, expect } from '@playwright/test';
import { mouseClick, inOverlay } from './helpers.mjs';

const COMMENTS = 'http://localhost:4173';
const ROOM = 'bridge';
const TEAM = 'team-e2e';
const CLIENT = 'client-e2e';
test.describe.configure({ mode: 'serial' });

// Is it on screen, not merely in the DOM.
const seen = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector('[data-fp-host]')?.shadowRoot?.querySelector(s);
    if (!el) return false;
    const c = getComputedStyle(el);
    return c.display !== 'none' && c.visibility !== 'hidden' && Number(c.opacity) > 0 && !el.hidden;
  }, sel);

async function gate(page, name, password) {
  await page.goto('/');
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForSelector('[data-fp-host]', { timeout: 15_000 });
}

// Read the room the way a person would: by signing in to it.
const roomThreads = (page, password) =>
  page.evaluate(
    async ([api, room, pass]) => {
      const q = `?room=${room}`;
      const login = await fetch(`${api}/api/login${q}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Reader', password: pass }),
      });
      const { token } = await login.json();
      const res = await fetch(`${api}/api/comments${q}`, { headers: { Authorization: `Bearer ${token}` } });
      return (await res.json()).threads;
    },
    [COMMENTS, ROOM, password]
  );

test('one password, typed once — the gate signs the reader in to the comments too', async ({ page }) => {
  await gate(page, 'Designer', TEAM);
  await page.waitForFunction(() => Boolean(window.__fp?.state?.role), null, { timeout: 15_000 });
  expect(await page.evaluate(() => window.__fp.state.role)).toBe('designer');
  expect(await seen(page, '.login-card')).toBe(false);
  expect(await seen(page, '.login-pill')).toBe(false);
  // One way to comment, not two.
  expect(await inOverlay(page, '.toolbar').count()).toBe(1);
  expect(await seen(page, '.toolbar')).toBe(true);
});

test('a session that predates the gate learning this still gets one', async ({ page }) => {
  // The state the first report came from: signed in to the page a while ago, so
  // the gate never runs again and never mints anything. /api/comments-token is
  // what covers them, and an expired token lands in the same place.
  await gate(page, 'Designer', TEAM);
  await page.waitForFunction(() => Boolean(window.__fp?.state?.role), null, { timeout: 15_000 });
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('fp_token::')) localStorage.removeItem(k);
    sessionStorage.setItem('fp_login_dismissed', '1'); // and they dismissed the panel once
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__fp?.state?.role), null, { timeout: 15_000 });
  expect(await page.evaluate(() => window.__fp.state.role)).toBe('designer');
  expect(await seen(page, '.login-pill')).toBe(false);
  expect(await seen(page, '.toolbar')).toBe(true);
});

test('a comment lands in this page’s room on the other host', async ({ page }) => {
  await gate(page, 'Designer', TEAM);
  await page.waitForFunction(() => Boolean(window.__fp?.state?.role), null, { timeout: 15_000 });
  await mouseClick(page, inOverlay(page, '.tb-btn').first());
  await expect(inOverlay(page, '.click-layer')).toBeVisible();
  await mouseClick(page, page.locator('h1').first());
  const ta = inOverlay(page, '.popover textarea');
  await expect(ta).toBeVisible();
  await ta.fill('bridge: the header needs a back link');
  await page.keyboard.press('Enter');
  await expect(inOverlay(page, '.popover .msg .text').filter({ hasText: 'bridge:' })).toBeVisible({ timeout: 15_000 });

  const threads = await roomThreads(page, TEAM);
  expect(threads.some((t) => t.messages[0].text.startsWith('bridge:'))).toBe(true);
});

test('the client signs in once too, and reads only their own', async ({ page }) => {
  await gate(page, 'Client', CLIENT);
  await page.waitForFunction(() => Boolean(window.__fp?.state?.role), null, { timeout: 15_000 });
  expect(await page.evaluate(() => window.__fp.state.role)).toBe('client');
  expect(await seen(page, '.login-card')).toBe(false);
  expect(
    await page.evaluate(() => window.__fp.state.threads.filter((t) => t.messages[0].text.startsWith('bridge:')).length)
  ).toBe(0);
});

test('with the bridge gone the panel asks — and takes the toolbar with it', async ({ page }) => {
  // What a host with different passwords looks like. The overlay's own login is
  // the fallback, and while it is asking there must be exactly one way in: a
  // toolbar beside it can post nothing and reads as a second comment tool.
  await gate(page, 'Designer', TEAM);
  await page.waitForFunction(() => Boolean(window.__fp?.state?.role), null, { timeout: 15_000 });
  await page.route('**/api/comments-token', (r) => r.fulfill({ status: 404, body: '{}' }));
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('fp_token::')) localStorage.removeItem(k);
  });
  await page.reload();
  await expect(inOverlay(page, '.login-card')).toBeVisible({ timeout: 15_000 });
  expect(await seen(page, '.toolbar')).toBe(false);

  await mouseClick(page, inOverlay(page, '.login-close'));
  await expect(inOverlay(page, '.login-pill')).toBeVisible();
  expect(await seen(page, '.toolbar')).toBe(false);

  // And the fallback actually works: the password still gets them in.
  await mouseClick(page, inOverlay(page, '.login-pill'));
  await inOverlay(page, '.login-input').first().fill('Designer');
  await inOverlay(page, '.login-input').nth(1).fill(TEAM);
  await mouseClick(page, inOverlay(page, '.login-btn:not(.secondary)'));
  await page.waitForFunction(() => Boolean(window.__fp?.state?.role), null, { timeout: 15_000 });
  expect(await seen(page, '.toolbar')).toBe(true);
  expect(await seen(page, '.login-pill')).toBe(false);
});
