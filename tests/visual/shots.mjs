// Visual QA: seed the fixture with every kind of data, screenshot the overlay's
// states in light/dark × desktop/touch, and check text contrast (WCAG AA).
//   bash tests/fixtures/serve.sh &   then   node tests/visual/shots.mjs
// Output: docs/superpowers/visual/*.png and a contrast report on stdout.
import { chromium, devices } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';

const BASE = 'http://localhost:4173';
const OUT = new URL('../../docs/superpowers/visual/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PIXEL = 'data:image/png;base64,' + readFileSync(new URL('../fixtures/pixel.png', import.meta.url)).toString('base64');

const browser = await chromium.launch();

async function login(page, name, pass) {
  await page.goto(BASE + '/');
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Password').fill(pass);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForSelector('[data-fp-host]');
  await page.waitForTimeout(1800);
}
const api = (page, body) =>
  page.evaluate(async (b) => (await fetch('/api/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json(), body);
const sr = (page, sel) => page.locator(`[data-fp-host] >> ${sel}`);
const click = async (page, loc) => {
  await loc.scrollIntoViewIfNeeded();
  const b = await loc.boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
};

// ---- seed once (designer + client)
{
  const d = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await login(d, 'Dmytro', 'team-e2e');
  const anchorH1 = { path: 'section[data-route="home"] > h1:nth-of-type(1)', t: 'h1', txt: 'Home', ox: 0.5, oy: 0.5, fx: 0.1, fy: 0.15 };
  const a = await api(d, { action: 'create', text: 'The heading feels too heavy for a landing screen — try 28px.', screen: 'Home', screenLabel: 'Home', anchor: anchorH1, page: '/', kind: 'idea', images: [PIXEL] });
  await api(d, { action: 'reply', threadId: a.thread.id, text: 'Agreed, tried 28/32 — 30 reads best on the laptop.' });
  await api(d, { action: 'status', threadId: a.thread.id, status: 'progress' });
  await api(d, { action: 'react', threadId: a.thread.id, at: a.thread.messages[0].at, emoji: '👍', on: true });
  const b = await api(d, { action: 'create', text: 'Sort menu: "Date" should be default, not "Name".', screen: 'Home', screenLabel: 'Home', anchor: { path: 'div[id="sort-menu"] > button:nth-of-type(3)', t: 'button', txt: 'Date', ox: 0.5, oy: 0.5, fx: 0.2, fy: 0.3, container: { path: 'div[id="sort-menu"]', role: 'menu', name: 'Sort menu' } }, page: '/', kind: 'bug', trail: [{ anchor: { path: 'button[id="sort-btn"]', t: 'button', txt: 'Sort' }, txt: 'Sort' }] });
  await api(d, { action: 'status', threadId: b.thread.id, status: 'wont', note: 'Name is the product default across all lists.' });
  const c = await api(d, { action: 'create', text: 'Where does the checkbox state get saved?', screen: 'Settings', screenLabel: 'Settings', anchor: { path: 'section[data-route="settings"] > h1:nth-of-type(1)', t: 'h1', txt: 'Settings', ox: 0.5, oy: 0.5, fx: 0.1, fy: 0.15 }, page: '/#/settings', kind: 'question' });
  await api(d, { action: 'status', threadId: c.thread.id, status: 'done' });
  const proto = await d.evaluate(() => window.__fp.state.proto);
  await api(d, { action: 'version-label', id: proto, label: 'Sprint 12' });
  await d.evaluate(() => (document.querySelector('[data-fp-host]').style.visibility = 'hidden'));
  const shot = await d.screenshot({ type: 'jpeg', quality: 70 });
  await d.evaluate(() => (document.querySelector('[data-fp-host]').style.visibility = ''));
  await api(d, { action: 'shot', label: 'Home', image: 'data:image/jpeg;base64,' + shot.toString('base64') });
  await api(d, { action: 'shot', label: 'Settings', image: 'data:image/jpeg;base64,' + shot.toString('base64') });
  await api(d, { action: 'shot', label: 'Home · Confirm', image: 'data:image/jpeg;base64,' + shot.toString('base64') });
  // Enough edges that labels can collide — a two-node map proves nothing about layout.
  await api(d, { action: 'edge', from: 'Home', to: 'Settings', anchor: { path: 'header > a:nth-of-type(2)', t: 'a', txt: 'Settings' } });
  await api(d, { action: 'edge', from: 'Home', to: 'Home · Confirm', anchor: { path: 'p > button', t: 'button', txt: 'Open dialog' } });
  await api(d, { action: 'edge', from: 'Home · Confirm', to: 'Home', anchor: { path: 'dialog > button', t: 'button', txt: 'Close' } });
  await api(d, { action: 'edge', from: 'Settings', to: 'Home', anchor: { path: 'header > a:nth-of-type(1)', t: 'a', txt: 'Home' } });
  await d.close();
  const c2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await login(c2, 'Olena (client)', 'client-e2e');
  await api(c2, { action: 'create', text: 'Can we get a bigger tap target here on mobile?', screen: 'Home', screenLabel: 'Home', anchor: { path: 'section[data-route="home"] > p:nth-of-type(2) > button:nth-of-type(1)', t: 'button', txt: 'Open dialog', ox: 0.5, oy: 0.5, fx: 0.1, fy: 0.4 }, page: '/' });
  await c2.close();
}

// ---- contrast helpers (evaluated in page)
const CONTRAST_JS = `(() => {
  const host = document.querySelector('[data-fp-host]'); const r = host.shadowRoot;
  const parse = (c) => {
    if (!c || c === 'transparent' || c === 'none') return null;
    // The alpha default must be a *number*: '1' turns the compositing sum into
    // string concatenation and every ratio comes out near 1.
    const alpha = (v) => (v === undefined || !Number.isFinite(v) ? 1 : v);
    const rgb = c.match(/rgba?\\(([^)]+)\\)/);
    if (rgb) { const [R,G,B,A] = rgb[1].split(/[ ,\\/]+/).map(Number); return { r:R, g:G, b:B, a: alpha(A) }; }
    // color-mix() and modern syntaxes compute to color(srgb r g b / a) with 0..1 channels.
    const srgb = c.match(/color\\(srgb ([^)]+)\\)/);
    if (srgb) { const [R,G,B,A] = srgb[1].split(/[ ,\\/]+/).map(Number); return { r:R*255, g:G*255, b:B*255, a: alpha(A) }; }
    return null;
  };
  const lum = ({r,g,b}) => { const f = (v) => { v/=255; return v <= .03928 ? v/12.92 : ((v+.055)/1.055)**2.4; }; return .2126*f(r)+.7152*f(g)+.0722*f(b); };
  // Source-over with a real resulting alpha, so two stacked translucent layers
  // composite correctly instead of the first one turning opaque.
  const over = (fg, bg) => {
    const a = fg.a + bg.a * (1 - fg.a);
    if (!a) return { r:0, g:0, b:0, a:0 };
    const ch = (f, b) => (f * fg.a + b * bg.a * (1 - fg.a)) / a;
    return { r: ch(fg.r, bg.r), g: ch(fg.g, bg.g), b: ch(fg.b, bg.b), a };
  };
  const bgOf = (el) => {
    let n = el; let acc = { r:0, g:0, b:0, a:0 };
    while (n) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) { acc = over(acc, c); if (acc.a >= 0.999) return acc; }
      n = n.parentElement || n.getRootNode()?.host;
    }
    const body = parse(getComputedStyle(document.body).backgroundColor);
    const page = body && body.a > 0 ? body : { r:255, g:255, b:255, a:1 };
    return over(acc, page);
  };
  const ratio = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + .05) / (l2 + .05); };
  const sels = ['.status', '.status-tag', '.badge', '.num', '.time', '.sys-line', '.react-chip', '.chip', '.ver-meta',
    '.toast', '.sb-group', '.excerpt', '.replies', '.name', '.tb-label', '.kind-chip', '.goto-screen',
    '.menu-label', '.map-edge-label', '.sb-note', '.nav-pos', '.filter-chip', '.wont-note textarea', '.sort',
    '.in-container', '.map-name', '.present-dot', '.ver-label', '.excerpt',
    // the map's own vocabulary
    '.map-band', '.map-band-note', '.map-chip', '.map-total', '.map-ph-title', '.map-ph-note', '.map-act',
    '.start-flag', '.here-flag'];
  const out = [];
  const seen = new Set();
  for (const sel of sels) for (const el of r.querySelectorAll(sel)) {
    if (!el.getClientRects().length) continue;
    const cs = getComputedStyle(el);
    // SVG text is painted with fill, not color.
    const fg = parse(el instanceof SVGElement ? cs.fill : cs.color);
    if (!fg) continue;
    const bg = bgOf(el);
    const size = parseFloat(cs.fontSize); const bold = parseInt(cs.fontWeight,10) >= 700;
    // WCAG large text is 18pt / 14pt bold = 24px / 18.66px bold.
    const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    // Every distinct rendering of a selector, not just its first element.
    const key = sel + '|' + cs.color + '|' + cs.fill + '|' + JSON.stringify(bg) + '|' + size + '|' + cs.fontWeight;
    if (seen.has(key)) continue;
    seen.add(key);
    const c = ratio(over(fg, bg), bg);
    out.push({ sel, text: (el.textContent||'').trim().slice(0,24), size, ratio: +c.toFixed(2), need, ok: c >= need });
  }
  return out;
})()`;

const report = [];
async function shootAll(theme, device) {
  const ctx = await browser.newContext({ ...(device ? devices[device] : { viewport: { width: 1280, height: 800 } }), colorScheme: theme });
  const page = await ctx.newPage();
  if (theme === 'dark') await page.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => { document.body.style.background = '#111318'; document.body.style.color = '#e7e7ea'; }); });
  const tag = `${theme}-${device ? 'touch' : 'desktop'}`;
  await login(page, 'Dmytro', 'team-e2e');
  const shot = (name) => page.screenshot({ path: `${OUT}${name}-${tag}.png` });
  await shot('01-toolbar');
  await click(page, sr(page, '.tb-btn').nth(1)); await page.waitForTimeout(500);
  await shot('02-sidebar');
  report.push({ state: `sidebar-${tag}`, rows: await page.evaluate(CONTRAST_JS) });
  await sr(page, 'select.sort').selectOption('oldest'); await page.waitForTimeout(200);
  await click(page, sr(page, '.sb-row').first()); await page.waitForTimeout(700);
  await shot('03-popover');
  // Layout + theme diagnostics: truncation and theme-correct chips are the two
  // things a screenshot alone cannot prove.
  report.push({ state: `diag-${tag}`, rows: [], diag: await page.evaluate(() => {
    const r = document.querySelector('[data-fp-host]').shadowRoot;
    const name = r.querySelector('.popover .who .name');
    const st = r.querySelector('.popover .status');
    const cs = st && getComputedStyle(st);
    const clipped = [...r.querySelectorAll('.status-seg button, .popover .who .name, .sb-row .name, .map-name, .chip, .kind-chip, .in-container, .nav-pos, .status')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => `${el.className}:${(el.textContent || '').trim().slice(0, 18)}`);
    return {
      dark: r.querySelector('.root').classList.contains('dark'),
      nameFits: name ? name.scrollWidth <= name.clientWidth + 1 : null,
      statusColor: cs?.color, statusBg: cs?.backgroundColor,
      clipped,
    };
  }) });
  await click(page, sr(page, '.popover .status')); await page.waitForTimeout(300);
  await shot('04-status-menu');
  report.push({ state: `popover-${tag}`, rows: await page.evaluate(CONTRAST_JS) });
  await click(page, sr(page, '.status-menu button').filter({ hasText: 'Won’t do' })); await page.waitForTimeout(300);
  await shot('05-wont-note');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  await click(page, sr(page, '.tb-btn').nth(1)); await page.waitForTimeout(400);
  if (!device) { const row = sr(page, '.sb-row').nth(1); const b = await row.boundingBox(); await page.mouse.move(b.x + 40, b.y + 10); await page.waitForTimeout(700); await shot('06-hover-card'); await page.mouse.move(5, 5); }
  else { await click(page, sr(page, '.sb-row .eye').nth(1)); await page.waitForTimeout(500); await shot('06-hover-card'); await page.mouse.click(10, 10); }
  await click(page, sr(page, '.sb-versions')); await page.waitForTimeout(600);
  await shot('07-versions');
  report.push({ state: `versions-${tag}`, rows: await page.evaluate(CONTRAST_JS) });
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  await page.mouse.click(10, device ? 500 : 600); await page.keyboard.press('KeyM'); await page.waitForTimeout(900);
  await shot('08-map');
  report.push({ state: `map-${tag}`, rows: await page.evaluate(CONTRAST_JS) });
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  await page.keyboard.press('KeyH'); await page.waitForTimeout(300);
  await shot('09-presentation');
  await ctx.close();
}
await shootAll('light', null);
await shootAll('dark', null);
await shootAll('light', 'iPhone 13');
await shootAll('dark', 'iPhone 13');
await browser.close();

const fails = [];
for (const r of report) for (const row of r.rows) if (!row.ok) fails.push({ state: r.state, ...row });
const diags = report.filter((r) => r.diag).map((r) => ({ state: r.state, ...r.diag }));
const clipped = diags.flatMap((d) => d.clipped.map((c) => `${d.state}: ${c}`));
console.log(JSON.stringify({ sampled: report.reduce((n, r) => n + r.rows.length, 0), fails, clipped, diags }, null, 1));
// A measurement that cannot fail is decoration.
if (fails.length || clipped.length) process.exit(1);
