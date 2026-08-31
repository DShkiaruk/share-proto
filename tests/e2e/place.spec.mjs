import { test, expect } from '@playwright/test';
import { login, mouseClick, inOverlay, apiGet } from './helpers.mjs';

const TEAM = 'team-e2e';
const CLIENT = 'client-e2e';

async function commentAt(page, locator, text) {
  await mouseClick(page, inOverlay(page, '.tb-btn').first()); // Comment button
  await expect(inOverlay(page, '.click-layer')).toBeVisible();
  await mouseClick(page, locator);
  const ta = inOverlay(page, '.popover textarea');
  await expect(ta).toBeVisible();
  await ta.fill(text);
  await page.keyboard.press('Enter');
  await expect(inOverlay(page, '.popover .msg .text').filter({ hasText: text })).toBeVisible({ timeout: 10_000 });
  const { threads } = await apiGet(page, '/api/comments');
  const created = threads.find((t) => t.messages[0]?.text === text);
  // The viewport preview lands ~1 s later and triggers a refresh; wait for it so
  // a later step is not racing that re-render (same-document hash navigation
  // keeps this overlay instance alive).
  await page.waitForFunction(
    (id) => Boolean(window.__fp?.state.threads.find((t) => t.id === id)?.preview),
    created.id,
    { timeout: 15_000 }
  );
  return created;
}

test.describe.configure({ mode: 'serial' });

test('a comment inside a dropdown gets a container + trail; closed → ghost pin; ghost click reopens it', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await mouseClick(page, page.locator('#sort-btn')); // pointerdown opens the menu
  await expect(page.locator('#sort-menu')).toBeVisible();
  const t = await commentAt(page, page.getByRole('menuitem', { name: 'Price' }), 'inside menu');
  expect(t.anchor.container?.role).toBe('menu');
  expect(t.anchor.container?.name).toBe('Sort menu');
  expect(t.trail.length).toBeGreaterThanOrEqual(1);
  expect(t.trail.at(-1).txt).toBe('Sort');
  expect(t.page).toBe('/'); // fixture starts without a hash

  await page.keyboard.press('Escape'); // close popover
  await page.mouse.click(600, 700); // outside → menu closes
  await expect(page.locator('#sort-menu')).toBeHidden();
  const ghost = inOverlay(page, '.pin.ghost');
  await expect(ghost).toHaveCount(1);
  const gb = await ghost.boundingBox();
  const bb = await page.locator('#sort-btn').boundingBox();
  expect(Math.abs(gb.x + 4 - (bb.x + bb.width / 2))).toBeLessThan(60); // sits on the trigger
  await mouseClick(page, ghost);
  await expect(page.locator('#sort-menu')).toBeVisible({ timeout: 5000 });
  await expect(inOverlay(page, '.pin:not(.ghost)')).toHaveCount(1);
  await expect(inOverlay(page, '.popover')).toBeVisible();
});

test('a comment on another hash page: sidebar row navigates there in one click; deep link keeps the hash', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await mouseClick(page, page.getByRole('link', { name: 'Settings' }));
  await expect(page.locator('section[data-route="settings"] h1')).toBeVisible();
  const t = await commentAt(page, page.locator('section[data-route="settings"] h1'), 'on settings');
  expect(t.page).toBe('/#/settings');
  expect(t.screenLabel).toBe('Settings');

  await page.goto('/#/home'); // same document: only the hash changes
  await page.waitForFunction(() => window.__fp?.state.screen === 'Home'); // overlay settled after the route change
  await mouseClick(page, inOverlay(page, '.tb-btn').nth(1)); // Threads
  const row = inOverlay(page, '.sb-row').filter({ hasText: 'on settings' });
  await mouseClick(page, row);
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(inOverlay(page, '.popover .msg .text').filter({ hasText: 'on settings' })).toBeVisible({ timeout: 10_000 });

  await page.goto(`/?comment=${t.id}&keep=1#/settings`);
  await page.waitForSelector('[data-fp-host]');
  await expect(inOverlay(page, '.popover .msg .text').filter({ hasText: 'on settings' })).toBeVisible({ timeout: 15_000 });
  expect(page.url()).toMatch(/\?keep=1#\/settings$/); // only `comment` was stripped
});

test('numbers are global and identical for both roles; sorting and filters work', async ({ browser }) => {
  const designer = await browser.newPage();
  await login(designer, 'Designer', TEAM);
  const client = await browser.newPage();
  await login(client, 'Client', CLIENT);
  const c = await commentAt(client, client.locator('section[data-route="home"] h1'), 'client says hi');
  const mine = await apiGet(designer, '/api/comments');
  const all = mine.threads.map((t) => t.n).sort((a, b) => a - b);
  expect(all).toEqual([1, 2, 3]);
  expect(mine.threads.find((t) => t.id === c.id).n).toBe(3);
  const theirs = await apiGet(client, '/api/comments');
  expect(theirs.threads.map((t) => t.n)).toEqual([3]); // gaps for the client: same numbers for everyone

  await designer.reload(); // the overlay polls every 25 s — pick up the client's thread now
  await designer.waitForSelector('[data-fp-host]');
  await mouseClick(designer, inOverlay(designer, '.tb-btn').nth(1));
  await expect(inOverlay(designer, '.sb-row .num').first()).toHaveText('#3'); // newest first
  await inOverlay(designer, 'select.sort').selectOption('oldest');
  // the client's fresh thread sits in "New for you" above the list for the first minute
  await expect(inOverlay(designer, '.sb-row:not(.new) .num').first()).toHaveText('#1');
  await mouseClick(designer, inOverlay(designer, '.chip').filter({ hasText: 'Client' }));
  await expect(inOverlay(designer, '.sb-row')).toHaveCount(1);
  await expect(inOverlay(designer, '.pin')).toHaveCount(1);
  await expect(inOverlay(client, '.chips')).toHaveCount(0); // no role filter for clients
});

test('H hides everything and the dot brings it back; J/K walk comments', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await page.mouse.click(600, 720); // focus the page body
  await page.keyboard.press('KeyH');
  await expect(inOverlay(page, '.toolbar')).toBeHidden();
  await expect(inOverlay(page, '.pins')).toBeHidden();
  const dot = inOverlay(page, '.present-dot');
  await expect(dot).toBeVisible();
  await page.waitForTimeout(150); // let the compositor commit a frame with the new element before hit-testing a click
  await mouseClick(page, dot);
  await expect(inOverlay(page, '.toolbar')).toBeVisible();

  await page.keyboard.press('KeyJ');
  await expect(inOverlay(page, '.popover .num')).toHaveText('#1', { timeout: 10_000 });
  await expect(inOverlay(page, '.popover .nav-pos')).toHaveText('1 of 3');
  await page.keyboard.press('KeyJ');
  await expect(inOverlay(page, '.popover .num')).toHaveText('#2', { timeout: 10_000 });
  await page.keyboard.press('KeyK');
  await expect(inOverlay(page, '.popover .num')).toHaveText('#1', { timeout: 10_000 });
});

// The README says comments may not be placeable inside a native modal dialog.
// This pins what actually happens, because "not placeable" undersells it: while
// showModal() is up, everything outside the dialog is inert, so the overlay
// cannot be clicked at all — and it must come back the moment the dialog closes.
// Creates no comment on purpose: later specs count what place.spec left behind.
test('a native modal dialog makes the overlay unreachable, and closing it gives the overlay back', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  const toolbarHit = () =>
    page.evaluate(() => {
      const host = document.querySelector('[data-fp-host]');
      const r = host.shadowRoot.querySelector('.tb-btn').getBoundingClientRect();
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === host;
    });
  expect(await toolbarHit()).toBe(true);

  await page.locator('#open-dialog').click();
  await expect(page.locator('#dlg')).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('#dlg').matches(':modal'))).toBe(true);
  expect(await toolbarHit(), 'the toolbar is behind the modal, not merely unclickable').toBe(false);

  await page.locator('#dlg-close').click();
  await expect(page.locator('#dlg')).toBeHidden();
  expect(await toolbarHit()).toBe(true);
  await mouseClick(page, inOverlay(page, '.tb-btn').first());
  await expect(inOverlay(page, '.click-layer')).toBeVisible(); // it really is live again
  await page.keyboard.press('Escape');
});

// A detail panel docked in the layout — no role, no aria, position static — is
// invisible to findContainer(), so this used to store no trail at all. Closing
// the panel then left the comment's pin sitting on whatever had been behind it,
// pointing at a row it was never about. Reported from the live deployment.
test('a comment in a docked panel ghosts onto the row that opens it, instead of stranding a pin', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  const row = page.locator('.row[data-name="Acme invoice"]'); // not by name: the ghost pin is labelled after it
  await mouseClick(page, row);
  await expect(page.locator('#details')).toBeVisible();

  const t = await commentAt(page, page.locator('#details-preview'), 'the preview is empty here');
  expect(t.anchor.container, 'the panel is not a floating layer — nothing to classify').toBeFalsy();
  expect(t.trail.length, 'but the click that opens it was kept').toBeGreaterThan(0);
  expect(t.trail.at(-1).txt).toBe('Acme invoice');
  await page.keyboard.press('Escape');

  const pin = inOverlay(page, `.pin`).filter({ hasText: String(t.n) });
  const inPanel = await pin.boundingBox();
  const panelBox = await page.locator('#details').boundingBox();
  expect(inPanel.x).toBeGreaterThan(panelBox.x - 40); // the real pin is on the panel

  await mouseClick(page, page.locator('#details-close'));
  await expect(page.locator('#details')).toBeHidden();
  await expect(pin).toHaveClass(/ghost/);
  const onRow = await pin.boundingBox();
  const rowBox = await row.boundingBox();
  expect(Math.abs(onRow.x - (rowBox.x + rowBox.width / 2))).toBeLessThan(30);
  expect(Math.abs(onRow.y - (rowBox.y + rowBox.height / 2))).toBeLessThan(30);

  // And it is a way back in, not just a marker.
  await mouseClick(page, pin);
  await expect(page.locator('#details')).toBeVisible({ timeout: 10_000 });
  await expect(pin).not.toHaveClass(/ghost/);

  await page.evaluate(
    async (id) =>
      fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', threadId: id }),
      }),
    t.id
  );
});

// The reported case, end to end: a comment made before trails were recorded,
// whose element lives in a panel nothing marks as a container. Clicking it used
// to say "this isn't open" and stop. Now it waits, opens on the element the
// moment the panel comes back, and remembers how — so the next time it opens
// the panel itself.
test('a comment with no trail learns the way back the first time someone opens it', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  const t = await page.evaluate(async () => {
    const r = await fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'create',
        text: 'made before trails existed',
        screen: 'Home',
        screenLabel: 'Home',
        page: '/',
        anchor: { path: '#details-preview', t: 'p', txt: 'Preview placeholder', fx: 0.5, fy: 0.5 },
      }),
    });
    return (await r.json()).thread;
  });
  expect(t.trail).toEqual([]);

  await page.reload();
  await page.waitForFunction(() => Boolean(window.__fp?.state.role));
  await expect(page.locator('#details')).toBeHidden();

  // Clicking it arms a watch rather than giving up.
  await mouseClick(page, inOverlay(page, '.tb-btn').nth(1));
  await mouseClick(page, inOverlay(page, '.sb-row').filter({ hasText: 'made before trails' }).first());
  await expect(inOverlay(page, '.toast')).toContainText('Preview placeholder', { timeout: 10_000 });

  // The reviewer opens the panel by hand; the comment lands on it.
  await mouseClick(page, page.locator('.row[data-name="Globex receipt"]'));
  await expect(page.locator('#details')).toBeVisible();
  await expect(inOverlay(page, '.popover .msg .text').filter({ hasText: 'made before trails' })).toBeVisible({ timeout: 10_000 });

  // And it kept the way back.
  await expect
    .poll(async () => (await apiGet(page, '/api/comments')).threads.find((x) => x.id === t.id)?.trail.length, { timeout: 15_000 })
    .toBeGreaterThan(0);

  // Next time: no asking, the panel opens itself.
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__fp?.state.role));
  await expect(page.locator('#details')).toBeHidden();
  await mouseClick(page, inOverlay(page, '.tb-btn').nth(1));
  await mouseClick(page, inOverlay(page, '.sb-row').filter({ hasText: 'made before trails' }).first());
  await expect(page.locator('#details')).toBeVisible({ timeout: 15_000 });

  await page.evaluate(
    (id) => fetch('/api/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', threadId: id }) }),
    t.id
  );
});
