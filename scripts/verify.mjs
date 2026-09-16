#!/usr/bin/env node
/* Walk a live deployment the way a reviewer does, and measure what happened.
 *
 *   node scripts/verify.mjs <url> --team <pw> --client <pw>
 *        [--room <name>] [--deep /some/inner/path] [--skip-map] [--headed]
 *
 * smoke.sh checks the contract over HTTP. This checks the thing a person
 * actually gets: one sign-in, one way to comment, a comment that survives a
 * reload, a client who cannot read the team's comments, a map with something in
 * it. Every failure this script has is one a designer found first at least once.
 *
 * It creates one comment and deletes it again; it fails rather than leaves a
 * mess. Exit 0 = ready to hand over.
 */
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const opt = (k, d = null) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const has = (k) => args.includes(`--${k}`);
const url = args.find((a) => !a.startsWith('--') && /^https?:\/\//.test(a));
const TEAM = opt('team');
const CLIENT = opt('client');
const ROOM = opt('room');
const DEEP = opt('deep');
if (!url || !TEAM || !CLIENT) {
  console.error(
    'usage: verify.mjs <url> --team <pw> --client <pw> [--room <name>] [--deep <path>] [--skip-map] [--headed]'
  );
  process.exit(2);
}
const BASE = url.replace(/\/+$/, '');

let fails = 0;
const notes = [];
const check = (got, want, what, remedy) => {
  const ok = String(got) === String(want);
  if (!ok) {
    fails++;
    if (remedy) notes.push(`${what}\n      → ${remedy}`);
  }
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `  (got: ${got}, want: ${want})`}`);
};
const section = (s) => console.log(`\n${s}`);

const inOverlay = (page, sel) => page.locator(`[data-fp-host] >> ${sel}`);
const seen = (page, sel) =>
  page.evaluate((s) => {
    const host = document.querySelector('[data-fp-host]');
    const el = host?.shadowRoot?.querySelector(s);
    if (!el) return false;
    const c = getComputedStyle(el);
    return c.display !== 'none' && c.visibility !== 'hidden' && Number(c.opacity) > 0 && !el.hidden;
  }, sel);
async function mouseClick(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  if (!b) throw new Error('not visible');
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}

const browser = await chromium.launch({ headless: !has('headed') });
const errors = [];

async function signIn(password, who) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Your name').fill(who);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForSelector('body *', { timeout: 20_000 });
  // The overlay may take a moment to reach the comments host.
  await page.waitForFunction(() => Boolean(window.__fp?.state?.role), null, { timeout: 20_000 }).catch(() => {});
  return page;
}

console.log(`verify → ${BASE}${ROOM ? `  (room ${ROOM})` : ''}`);

/* ---------- the gate ---------- */
section('The gate');
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const r = await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  check(r.status(), 200, 'the site answers');
  check((await page.content()).includes('protected prototype'), true, 'a stranger gets the login page, not the prototype');
  if (DEEP) {
    const d = await page.goto(BASE + DEEP, { waitUntil: 'domcontentloaded' });
    check(d.status(), 200, `${DEEP} is gated, not a 404`, 'client-side routes need the SPA rewrite in vercel.json (or server.js --spa)');
    check((await page.content()).includes('protected prototype'), true, '…and shows the login page');
  }
  await ctx.close();
}

/* ---------- the reviewer ---------- */
section('Signing in as the team');
const page = await signIn(TEAM, 'Verifier');
check(await page.evaluate(() => window.__fp?.state?.role), 'designer', 'the team password gives the designer role');
check(
  await seen(page, '.login-card'),
  false,
  'the comment panel does not ask for the password a second time',
  'the gate mints a comments session only when the two passwords match — check them, and that /api/comments-token answers'
);
check(await seen(page, '.login-pill'), false, 'no "Review comments" pill left over');
check(await seen(page, '.toolbar'), true, 'the toolbar is there');
check(await inOverlay(page, '.toolbar').count(), 1, 'exactly one toolbar — one way to comment, not two');
check(
  await page.evaluate(() => document.querySelectorAll('[data-fp-host]').length),
  1,
  'exactly one overlay on the page'
);

if (DEEP) {
  section('A link into an inner screen');
  const d = await page.goto(BASE + DEEP, { waitUntil: 'domcontentloaded' });
  check(d.status(), 200, `${DEEP} returns 200`, 'add the SPA rewrite: template/vercel.json, or run the local server with --spa');
  await page.waitForFunction(() => Boolean(window.__fp?.state?.role), null, { timeout: 20_000 }).catch(() => {});
  check(await page.evaluate(() => location.pathname), DEEP, '…and stays at the path that was asked for');
  const asset = await page.evaluate(async () => {
    const src = [...document.querySelectorAll('script[src^="/assets/"], script[src^="/"]')]
      .map((s) => s.getAttribute('src'))
      .find((s) => s && s.endsWith('.js'));
    if (!src) return null;
    const r = await fetch(src);
    return { src, status: r.status, type: r.headers.get('content-type') || '' };
  });
  if (asset) {
    check(asset.status, 200, `the bundle is served as itself (${asset.src})`);
    check(/javascript/.test(asset.type), true, '…as JavaScript, not swallowed by the rewrite');
  }
}

/* ---------- leaving a comment ---------- */
section('Leaving a comment');
const MARK = `verify ${Date.now()}`;
await mouseClick(page, inOverlay(page, '.tb-btn').first());
await inOverlay(page, '.click-layer').waitFor({ state: 'visible', timeout: 10_000 });
const target = page.locator('h1, h2, [role="heading"]').first();
await mouseClick(page, (await target.count()) ? target : page.locator('body'));
const ta = inOverlay(page, '.popover textarea');
await ta.waitFor({ state: 'visible', timeout: 10_000 });
// The prototype's own shortcuts must not reach the page while someone types,
// and Backspace must delete. Both have been broken here before.
await ta.fill(`${MARK} cm`);
await page.keyboard.press('Backspace');
check(await ta.inputValue(), `${MARK} c`, 'Backspace deletes in the composer, and c/m do not reach the prototype');
await ta.fill(MARK);
await page.keyboard.press('Enter');
await inOverlay(page, '.popover .msg .text').filter({ hasText: MARK }).waitFor({ timeout: 20_000 });

const where = await page.evaluate(() => location.pathname);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__fp?.state?.role), null, { timeout: 20_000 });
const mine = await page.evaluate((m) => {
  const t = window.__fp.state.threads.filter((x) => x.messages[0].text.startsWith(m));
  return { n: t.length, page: t[0]?.page || null, id: t[0]?.id || null };
}, MARK);
check(mine.n, 1, 'the comment is still there after a reload');
check(mine.page, where, '…and remembers the screen it was left on');

/* ---------- the map ---------- */
if (!has('skip-map')) {
  section('The map');
  await page.keyboard.press('m');
  await page.waitForTimeout(2000);
  const map = await page.evaluate(() => {
    const r = document.querySelector('[data-fp-host]').shadowRoot;
    const m = r.querySelector('.map');
    if (!m) return null;
    const view = m.getBoundingClientRect();
    const cards = [...r.querySelectorAll('.map-node')].map((n) => ({
      blank: n.classList.contains('blank'),
      box: n.getBoundingClientRect(),
    }));
    return {
      cards: cards.length,
      withPicture: cards.filter((c) => !c.blank).length,
      width: cards.length ? cards[0].box.width : 0,
      inside: cards.every(
        (c) => c.box.top >= view.top - 1 && c.box.bottom <= view.bottom + 1 && c.box.left >= view.left - 1 && c.box.right <= view.right + 1
      ),
    };
  });
  check(Boolean(map), true, 'M opens the map');
  if (map) {
    check(
      map.cards >= 2,
      true,
      `the map knows more than one screen (${map.cards})`,
      'a room nobody has walked knows one screen — run scripts/crawl.mjs against this URL before handing it over'
    );
    check(map.withPicture, map.cards, 'every screen has a picture of itself', 'crawl.mjs posts them; if it reported shots: 0 the shots went to the wrong host');
    check(map.inside, true, 'the whole map fits in the panel when it opens');
    check(map.width > 70, true, `the cards are big enough to recognise (${Math.round(map.width)}px)`);
  }
  await page.keyboard.press('Escape');
}

/* ---------- the client ---------- */
section('Signing in as the client');
const cpage = await signIn(CLIENT, 'Verifier client');
check(await cpage.evaluate(() => window.__fp?.state?.role), 'client', 'the client password gives the client role');
check(await seen(cpage, '.login-card'), false, 'the client is not asked for the password twice either');
check(
  await cpage.evaluate((m) => window.__fp.state.threads.filter((t) => t.messages[0].text.startsWith(m)).length, MARK),
  0,
  "the client cannot see the team's comment"
);

/* ---------- clean up after ourselves ---------- */
section('Cleaning up');
if (mine.id) {
  await page.evaluate(async (id) => window.__fp.api('POST', { action: 'delete', threadId: id }), mine.id);
  await page.evaluate(() => window.__fp.refresh());
  check(
    await page.evaluate((m) => window.__fp.state.threads.filter((t) => t.messages[0].text.startsWith(m)).length, MARK),
    0,
    'the comment this check made is gone again'
  );
}
check(errors.filter((e) => /CORS|blocked|Failed to fetch/i.test(e)).length, 0, 'no CORS or failed requests in the console');

await browser.close();
console.log(`\n${fails ? `${fails} FAILED` : 'ALL OK — ready to hand over'}`);
for (const n of notes) console.log(`  · ${n}`);
process.exit(fails ? 1 : 0);
