import { chromium } from '@playwright/test';

const URL = 'https://filepig-prototype-sigma.vercel.app';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 120)); });
const sr = (s) => p.locator(`[data-fp-host] >> ${s}`);
const out = [];
const check = (ok, label, extra = '') => out.push(`${ok ? '  ok  ' : '  FAIL'} ${label}${extra ? '  — ' + extra : ''}`);

await p.goto(URL);
await p.getByLabel('Your name').fill('Dima');
await p.getByLabel('Password').fill('oink-crew-376a');
await p.getByRole('button', { name: 'Continue' }).click();
await p.waitForFunction(() => Boolean(window.__fp?.state.role), null, { timeout: 30000 });
await p.waitForTimeout(2500);

// --- open the list
const tb = await sr('.tb-btn').filter({ hasText: 'Threads' }).boundingBox();
await p.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2);
await p.waitForFunction(() => window.__fp.state.sidebar === true);
await p.waitForTimeout(700);
const rows = await sr('.sb-row').count();
check(rows > 5, `list opens with real data (${rows} rows)`);

// --- 4) dates: one right edge for every row
const rights = await p.evaluate(() => {
  const r = document.querySelector('[data-fp-host]').shadowRoot;
  return [...r.querySelectorAll('.sb-row .time')].map((e) => +e.getBoundingClientRect().right.toFixed(1));
});
const spread = Math.max(...rights) - Math.min(...rights);
check(spread === 0, `every date ends on the same x (${rights.length} rows, spread ${spread}px)`);

// --- 3/5) what a row is allowed to carry
const rowStuff = await p.evaluate(() => {
  const r = document.querySelector('[data-fp-host]').shadowRoot;
  return {
    badges: r.querySelectorAll('.sb-row .badge').length,
    statusWords: r.querySelectorAll('.sb-row .status-tag').length,
    glyphs: r.querySelectorAll('.sb-row .st-ico').length,
    clientRings: r.querySelectorAll('.sb-row .avatar.r-client').length,
    excerptColor: getComputedStyle(r.querySelector('.sb-row .excerpt')).color,
    metaColor: getComputedStyle(r.querySelector('.sb-row .meta')).color,
  };
});
check(rowStuff.badges === 0 && rowStuff.statusWords === 0, 'no role/status chips left on rows', JSON.stringify(rowStuff));
check(rowStuff.excerptColor !== rowStuff.metaColor, 'the comment is the darkest text in its row');

// --- open a thread: the list stays, the popover keeps clear of it
const rb = await sr('.sb-row').nth(1).boundingBox();
await p.mouse.click(rb.x + 60, rb.y + 20);
await p.waitForTimeout(2500);
check(await p.evaluate(() => window.__fp.state.sidebar), 'the list stays open when a comment is opened');
const geo = await p.evaluate(() => {
  const r = document.querySelector('[data-fp-host]').shadowRoot;
  const pop = r.querySelector('.popover').getBoundingClientRect();
  const sb = r.querySelector('.sidebar').getBoundingClientRect();
  return { popRight: pop.right, sbLeft: sb.left };
});
check(geo.popRight <= geo.sbLeft + 1, 'the popover does not go under the list', JSON.stringify(geo));

// --- 5) the status control is a control
const st = await p.evaluate(() => {
  const r = document.querySelector('[data-fp-host]').shadowRoot;
  const b = r.querySelector('.popover .status');
  const cs = getComputedStyle(b);
  return { tag: b.tagName, chevron: !!b.querySelector('.chev svg'), glyph: !!b.querySelector('.st-ico svg'),
           haspopup: b.getAttribute('aria-haspopup'), bg: cs.backgroundColor, h: b.getBoundingClientRect().height,
           label: b.querySelector('.status-label').textContent };
});
check(st.tag === 'BUTTON' && st.chevron && st.glyph && st.haspopup === 'menu', `status reads as a control ("${st.label}")`, JSON.stringify(st));
const sbox = await sr('.popover .status').boundingBox();
await p.mouse.move(sbox.x + sbox.width / 2, sbox.y + sbox.height / 2);
await p.waitForTimeout(250);
const hoverBg = await p.evaluate(() => getComputedStyle(document.querySelector('[data-fp-host]').shadowRoot.querySelector('.popover .status')).backgroundColor);
check(hoverBg !== st.bg, 'it answers the pointer', `${st.bg} → ${hoverBg}`);
await p.mouse.click(sbox.x + sbox.width / 2, sbox.y + sbox.height / 2);
await p.waitForTimeout(400);
const menu = await p.evaluate(() => {
  const r = document.querySelector('[data-fp-host]').shadowRoot;
  const m = r.querySelector('.status-menu');
  return m ? [...m.querySelectorAll('button[role=menuitem]')].map((b) => [b.textContent.trim(), !!b.querySelector('.st-ico svg')]) : null;
});
check(menu && menu.length === 4 && menu.every(([, g]) => g), 'the menu carries the same four glyphs', JSON.stringify(menu));
await p.keyboard.press('Escape');
await p.waitForTimeout(200);

// --- 2) backspace, in all three places text can be typed
async function typeAndDelete(loc, label) {
  await loc.click();
  await p.keyboard.type('abcm');
  const before = await loc.inputValue();
  await p.keyboard.press('Backspace');
  await p.keyboard.press('Backspace');
  await p.waitForTimeout(150);
  const after = await loc.inputValue();
  check(after.length === before.length - 2, `backspace deletes in ${label}`, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  for (let i = 0; i < after.length; i++) await p.keyboard.press('Backspace');
}
await typeAndDelete(sr('.popover .compose textarea'), 'the reply box');
const mode0 = await p.evaluate(() => [window.__fp.state.mode, window.__fp.state.map]);
check(String(mode0) === 'false,false', 'typing "c" and "m" did not fire the overlay shortcuts');

await p.keyboard.press('Escape');
await p.waitForTimeout(300);
await p.keyboard.press('c');
await p.mouse.click(700, 500);
await p.waitForTimeout(800);
await typeAndDelete(sr('.popover .compose textarea'), 'the new-comment composer');
const kinds = await sr('.kind-chip').count();
check(kinds === 3, 'the kind chips are there (Bug / Question / Idea)');
await p.keyboard.press('Escape');
await p.waitForTimeout(300);
check((await sr('.popover').count()) === 0, 'Escape from inside a field still closes the draft');

// --- the map still opens
await p.mouse.click(200, 700);
await p.keyboard.press('m');
await p.waitForTimeout(2000);
const cards = await sr('.map-node').count();
check(cards > 0, `the map opens with ${cards} cards`);
await p.keyboard.press('Escape');
await p.waitForTimeout(400);

// --- nothing created, nothing left behind
const threads = await p.evaluate(async () => (await (await fetch('/api/comments')).json()).threads.length);
check(threads === 18, `the room still holds its 18 threads (created nothing)`);
check(errs.length === 0, 'no page errors during the walk', errs.join(' | '));
console.log(out.join('\n'));
console.log(out.some((l) => l.startsWith('  FAIL')) ? '\nSOME CHECKS FAILED' : '\nALL OK');
await p.screenshot({ path: '.scratch/live-walk.png' });
await b.close();
