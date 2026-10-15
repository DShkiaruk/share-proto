import { test, expect, devices } from '@playwright/test';
import { login, mouseClick, inOverlay, apiGet } from './helpers.mjs';

/* What reviewers ran into on live links (October 2026), each written down as
   the check that would have caught it:
   - a client: "it freezes all the time and takes a long time to update";
   - a designer: "I hide it, and it shows up again anyway";
   - the same designer: "on a phone it's unclear how to leave, hide and so on".
   The heavy fixture (tests/fixtures/heavy.html) stands in for the prototypes
   these people review: hundreds of rows, live countdowns, lazy pictures. */

const TEAM = 'team-e2e';
const CLIENT = 'client-e2e';
// The phone's shape, not its engine: a device's browser type cannot change
// inside a describe group, and what is under test here is size and touch.
const { userAgent, viewport, deviceScaleFactor } = devices['iPhone 13'];
const PHONE = { userAgent, viewport, deviceScaleFactor, isMobile: true, hasTouch: true };

const pinsShown = (page) =>
  page.evaluate(() => {
    const root = document.querySelector('[data-fp-host]').shadowRoot;
    if (root.querySelector('.pins').style.display === 'none') return 0;
    return [...root.querySelectorAll('.pins .pin:not(.draft)')].filter((p) => p.style.display !== 'none').length;
  });

async function startLongTasks(page) {
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(Math.round(e.duration)))).observe({
      type: 'longtask',
    });
  });
}
const longest = (page) => page.evaluate(() => Math.max(0, ...window.__long));

async function postAt(page, x, y, text) {
  await mouseClick(page, inOverlay(page, '.tb-btn').first()); // Comment
  await page.mouse.click(x, y);
  const ta = inOverlay(page, '.popover textarea');
  await expect(ta).toBeVisible();
  await ta.fill(text);
  await page.keyboard.press('Enter');
}

async function threadByText(page, text) {
  return (await apiGet(page, '/api/comments')).threads.find((t) => t.messages[0].text === text);
}

/* ---------- "it freezes" ---------- */

test('posting on a heavy page does not freeze it, and the picture is still taken', async ({ page }) => {
  await login(page, 'Client', CLIENT);
  await page.waitForTimeout(500);
  await startLongTasks(page);
  await postAt(page, 700, 420, 'freeze: heavy page');
  await expect(inOverlay(page, '.popover .msg')).toBeVisible();
  // The picture used to copy every one of the page's 7 000 nodes — offscreen
  // rows included — in one go: 2.7 s with nothing on the page answering.
  await expect.poll(async () => (await threadByText(page, 'freeze: heavy page'))?.preview || null, { timeout: 10_000 }).not.toBeNull();
  expect(await longest(page)).toBeLessThan(1000);
});

test('a page of lazy pictures still gets its comment picture, and quickly', async ({ page }) => {
  await login(page, 'Client', CLIENT);
  await page.goto('/?rows=20&pics=12');
  await page.waitForFunction(() => Boolean(window.__fp?.state.role));
  await page.waitForTimeout(500);
  // Pictures below the view never load until scrolled to, and the capture used
  // to wait for every one of them: past the 4 s it allows itself, so a report
  // full of screenshots never got a picture at all — while still paying for it.
  const at = Date.now();
  await postAt(page, 700, 300, 'freeze: lazy pictures');
  await expect.poll(async () => (await threadByText(page, 'freeze: lazy pictures'))?.preview || null, { timeout: 10_000 }).not.toBeNull();
  expect(Date.now() - at).toBeLessThan(3500);
});

/* ---------- "it takes a long time to update" ---------- */

test('a posted comment shows at once, without waiting for the next full read', async ({ page }) => {
  await login(page, 'Client', CLIENT);
  // A slow read, as on a cold serverless function: the comment is already
  // saved and in hand, so making the reader wait on this is waiting for nothing.
  await page.route('**/api/comments', async (route) => {
    if (route.request().method() === 'GET') await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  await postAt(page, 500, 260, 'update: shows at once');
  await expect(inOverlay(page, '.popover .msg').filter({ hasText: 'update: shows at once' })).toBeVisible({ timeout: 1200 });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('a reply shows at once, too', async ({ page }) => {
  await login(page, 'Client', CLIENT);
  await postAt(page, 520, 300, 'update: reply root');
  await expect(inOverlay(page, '.popover .msg')).toBeVisible();
  await page.route('**/api/comments', async (route) => {
    if (route.request().method() === 'GET') await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  const ta = inOverlay(page, '.popover .compose textarea');
  await ta.fill('update: the reply');
  await page.keyboard.press('Enter');
  await expect(inOverlay(page, '.popover .msg').filter({ hasText: 'update: the reply' })).toBeVisible({ timeout: 1200 });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('a tab gone quiet looks again soon once the reader is back', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await page.evaluate(async () => {
    for (let i = 0; i < 20; i++) await window.__fp.refresh();
  });
  expect(await page.evaluate(() => window.__fp.pollEvery)).toBe(4 * 60 * 1000);
  // Pacing the *next* poll is not enough: the one already scheduled was four
  // minutes away, and a reviewer back at the page waited all of it to see a
  // reply that had landed long before.
  await page.evaluate(() => window.__fp.schedule(4 * 60 * 1000));
  await page.mouse.click(400, 300);
  expect(await page.evaluate(() => window.__fp.nextPollIn)).toBeLessThanOrEqual(25_000);

  // Coming back to the window from another app counts as being back.
  await page.evaluate(() => window.__fp.schedule(4 * 60 * 1000));
  const read = page.waitForRequest((r) => r.url().endsWith('/api/comments') && r.method() === 'GET', { timeout: 3000 });
  await page.evaluate(() => {
    window.__fp.forgetLastRead();
    window.dispatchEvent(new Event('focus'));
  });
  await read;
  expect(await page.evaluate(() => window.__fp.nextPollIn)).toBeLessThanOrEqual(25_000);
});

/* ---------- "I hide it, and it shows up again" ---------- */

test('hidden pins stay hidden after leaving a comment, and after a reload', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await page.goto('/?rows=12');
  await page.waitForFunction(() => Boolean(window.__fp?.state.role));
  await postAt(page, 600, 220, 'hide: before');
  await page.keyboard.press('Escape');
  expect(await pinsShown(page)).toBeGreaterThan(0);

  await mouseClick(page, inOverlay(page, 'button[aria-label="Hide comment pins"]'));
  expect(await pinsShown(page)).toBe(0);

  // Commenting shows the pins for as long as it lasts — you are placing one —
  // and gives the choice back when it is over.
  await postAt(page, 640, 300, 'hide: while hidden');
  await expect(inOverlay(page, '.popover .msg')).toBeVisible();
  expect(await pinsShown(page)).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  expect(await pinsShown(page)).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('fp_pins_hidden'))).toBe('1');

  await page.reload();
  await page.waitForFunction(() => Boolean(window.__fp?.state.role));
  await page.waitForTimeout(1500);
  expect(await pinsShown(page)).toBe(0);
});

test('a comment left on the bare page keeps its pin', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await page.goto('/?rows=3&short=1');
  await page.waitForFunction(() => Boolean(window.__fp?.state.role));
  // Below the content there is no element of the prototype's: the click lands
  // on the page itself — <body> or <html>, depending on the browser's hit test.
  const hit = await page.evaluate(() => document.elementsFromPoint(900, 640).find((e) => !e.matches('[data-fp-host]'))?.tagName);
  expect(['HTML', 'BODY']).toContain(hit);
  await postAt(page, 900, 640, 'bare: below the content');
  await expect(inOverlay(page, '.popover .msg')).toBeVisible();
  await page.keyboard.press('Escape');
  const pin = async () =>
    page.evaluate(() => {
      const t = window.__fp.state.threads.find((x) => x.messages[0].text === 'bare: below the content');
      const p = [...document.querySelector('[data-fp-host]').shadowRoot.querySelectorAll('.pins .pin')].find((x) => x.textContent.startsWith(String(t.n)));
      return p && p.style.display !== 'none' ? { x: Math.round(parseFloat(p.style.left)), y: Math.round(parseFloat(p.style.top)) } : null;
    });
  expect(await pin()).toEqual({ x: 900, y: 640 });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__fp?.state.threads.length));
  await page.waitForTimeout(1500);
  expect(await pin()).toEqual({ x: 900, y: 640 });
});

test('comments already saved with a broken page-background address find their place', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await page.goto('/?rows=3&short=1');
  await page.waitForFunction(() => Boolean(window.__fp?.state.role));
  // What earlier builds wrote for a click on <html> and on <body>: neither is
  // a selector the browser accepts, so the pin was never drawn.
  const ids = await page.evaluate(async () => {
    const st = window.__fp.state;
    const mk = async (path, text) =>
      (await window.__fp.api('POST', { action: 'create', text, screen: st.screen, screenLabel: st.screenLabel, page: location.pathname, trail: [], anchor: { path, t: path.includes('html') ? 'html' : 'body', txt: null, ox: 0.5, oy: 0.5, fx: 0.5, fy: 0.5, container: null } })).thread.n;
    return [await mk('body > html:nth-of-type(1)', 'bare: legacy html'), await mk('body > ', 'bare: legacy body')];
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__fp?.state.threads.length));
  await page.waitForTimeout(1500);
  const shown = await page.evaluate((ns) => {
    const pins = [...document.querySelector('[data-fp-host]').shadowRoot.querySelectorAll('.pins .pin')];
    return ns.map((n) => pins.some((p) => p.textContent.startsWith(String(n)) && p.style.display !== 'none'));
  }, ids);
  expect(shown).toEqual([true, true]);
});

/* ---------- "on a phone it's unclear" ---------- */

test.describe('on a phone', () => {
  test.use(PHONE);

  for (const [name, width] of [['iPhone 13', 390], ['Pixel 7', 412], ['iPhone 15 Pro Max', 430], ['iPhone SE', 320]]) {
    test(`the toolbar fits a ${width}px screen (${name})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 700 });
      await login(page, 'Phone Designer', TEAM);
      await page.waitForTimeout(400);
      const box = await inOverlay(page, '.toolbar').boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      // Every control a finger needs is on screen, the handle to move it included.
      for (const sel of ['.tb-grip', '.tb-btn >> nth=0', '.tb-btn >> nth=1', '.tb-hide']) {
        const b = await inOverlay(page, sel).boundingBox();
        expect(b, sel).not.toBeNull();
        expect(b.x, sel).toBeGreaterThanOrEqual(0);
        expect(b.x + b.width, sel).toBeLessThanOrEqual(width);
        expect(b.height, sel).toBeGreaterThanOrEqual(40);
      }
    });
  }

  test('everything hides with a tap, and one tap brings it back', async ({ page }) => {
    await login(page, 'Phone Client', CLIENT);
    await page.waitForTimeout(400);
    const tap = async (sel) => {
      const b = await inOverlay(page, sel).boundingBox();
      await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    };
    await tap('.tb-hide');
    await expect(inOverlay(page, '.toolbar')).toBeHidden();
    await expect(inOverlay(page, '.present-dot')).toBeVisible();
    // The way back has to be big enough to find with a thumb.
    const dot = await inOverlay(page, '.present-dot').boundingBox();
    expect(Math.min(dot.width, dot.height)).toBeGreaterThanOrEqual(40);
    await tap('.present-dot');
    await expect(inOverlay(page, '.toolbar')).toBeVisible();
  });
});
