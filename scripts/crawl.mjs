#!/usr/bin/env node
// Walk a share-proto deployment breadth-first with real mouse clicks so the
// overlay learns the navigation graph the way it learns from humans, and post
// a screenshot per screen for the map (M). Runs on the designer's machine:
// Playwright is a dev dependency of the skill repo, not of the template.
//
//   node scripts/crawl.mjs <url> --password <team-password>
//        [--depth 4] [--max-screens 60] [--viewport 1280x800] [--name Crawler] [--headed]
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
if (!url || !opt('password')) {
  console.error('usage: crawl.mjs <url> --password <team-password> [--depth 4] [--max-screens 60] [--viewport 1280x800] [--name Crawler] [--headed]');
  process.exit(2);
}
const DEPTH = Number(opt('depth', 4));
const MAX = Number(opt('max-screens', 60));
const [W, H] = opt('viewport', '1280x800').split('x').map(Number);
// Never press anything that could destroy the prototype's state.
const SKIP = /delete|remove|reset|sign out|log out|logout|clear|discard/i;
const t0 = Date.now();
const budget = () => Date.now() - t0 < 5 * 60 * 1000;

const browser = await chromium.launch({ headless: !args.includes('--headed') });
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.goto(url);
await page.getByLabel('Your name').fill(opt('name', 'Crawler'));
await page.getByLabel('Password').fill(opt('password'));
await page.getByRole('button', { name: 'Continue' }).click();
try {
  await page.waitForSelector('[data-fp-host]', { timeout: 20000 });
} catch {
  console.error('login failed — check the URL and the team password');
  await browser.close();
  process.exit(1);
}
const label = () => page.evaluate(() => (window.__fp ? window.__fp.label() : document.title));
const settle = (ms = 1200) => page.waitForTimeout(ms);

// Visible, enabled, non-destructive controls outside the overlay, as {txt, x, y}.
const controls = () =>
  page.evaluate(() => {
    const host = document.querySelector('[data-fp-host]');
    const out = [];
    for (const el of document.querySelectorAll('button, a, [role="button"], [role="tab"], [role="menuitem"], summary')) {
      if (host && (el === host || host.contains(el))) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.pointerEvents === 'none' || el.disabled) continue;
      if (el.tagName === 'A' && el.getAttribute('href') && /^(https?:)?\/\//.test(el.getAttribute('href'))) continue; // external
      const txt = (el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      out.push({ txt, x: r.left + r.width / 2, y: r.top + r.height / 2 });
    }
    return out;
  });

const showOverlay = (on) =>
  page.evaluate((v) => {
    const h = document.querySelector('[data-fp-host]');
    if (h) h.style.visibility = v;
  }, on ? '' : 'hidden');

const shoot = async (lbl) => {
  // The map wants the prototype, not the comment UI on top of it. Restore the
  // overlay even if the shot fails — otherwise the rest of the crawl is blind.
  let buf;
  await showOverlay(false);
  try {
    buf = await page.screenshot({ type: 'jpeg', quality: 80 });
  } finally {
    await showOverlay(true);
  }
  return page.evaluate(
    async ([l, b64]) =>
      (
        await fetch('/api/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'shot', label: l, image: 'data:image/jpeg;base64,' + b64 }),
        })
      ).ok,
    [lbl, buf.toString('base64')]
  );
};

// A path is the sequence of controls clicked from the boot screen. Every
// branch starts from a fresh load so prototype state never leaks between them.
const replay = async (path) => {
  await page.goto(url);
  await page.waitForSelector('[data-fp-host]');
  await settle();
  for (const step of path) {
    const cs = await controls();
    const hit = cs.find((c) => c.txt && c.txt === step.txt) || cs.find((c) => Math.hypot(c.x - step.x, c.y - step.y) < 8);
    if (!hit) return false;
    await page.mouse.click(hit.x, hit.y);
    await settle();
  }
  return true;
};

const seen = new Map(); // label → path
const queue = [[]];
let edges = 0;
let shots = 0;
await settle();
const boot = await label();
seen.set(boot, []);
if (await shoot(boot)) shots++;
console.log(`start: "${boot}"`);

while (queue.length && seen.size < MAX && budget()) {
  const path = queue.shift();
  if (path.length >= DEPTH) continue;
  if (!(await replay(path))) continue;
  const from = await label();
  const cs = (await controls()).filter((c) => c.txt && !SKIP.test(c.txt));
  const tried = new Set();
  // Reload only after a click that changed the screen: on heavy prototypes a
  // reload costs seconds, and most controls (menus, toggles) stay on-screen.
  let dirty = false;
  for (const c of cs) {
    if (!budget() || seen.size >= MAX) break;
    if (tried.has(c.txt)) continue;
    tried.add(c.txt);
    if (dirty) {
      if (!(await replay(path))) break;
      dirty = false;
    }
    const live = (await controls()).find((x) => x.txt === c.txt) || c; // position may have shifted
    await page.mouse.click(live.x, live.y);
    await settle(1200);
    const to = await label();
    if (to !== from) {
      dirty = true;
      if (!seen.has(to)) {
        seen.set(to, [...path, c]);
        queue.push([...path, c]);
        edges++; // the overlay records the edge itself from this trusted click
        if (await shoot(to)) shots++;
        console.log(`  "${from}" → "${to}"  via "${c.txt}"`);
      }
    }
  }
}
console.log(JSON.stringify({ screens: seen.size, edges, shots, seconds: Math.round((Date.now() - t0) / 1000) }));
await browser.close();
