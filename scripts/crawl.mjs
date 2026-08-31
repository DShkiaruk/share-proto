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
const FLAGS_WITH_VALUE = new Set(['--password', '--depth', '--max-screens', '--viewport', '--name']);
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    if (FLAGS_WITH_VALUE.has(args[i])) i++; // skip its value
    continue;
  }
  positional.push(args[i]);
}
const url = positional[0];
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
const USAGE =
  'usage: crawl.mjs <url> --password <team-password> [--depth 4] [--max-screens 60] [--viewport 1280x800] [--name Crawler] [--headed]\n' +
  '       stops after 5 minutes; start with --max-screens 10 on an unfamiliar prototype';
if (!url || !opt('password')) {
  console.error(USAGE);
  process.exit(2);
}
const num = (k, d) => {
  const v = Number(opt(k, d));
  if (!Number.isFinite(v) || v <= 0) {
    console.error(`--${k} must be a positive number\n${USAGE}`);
    process.exit(2);
  }
  return v;
};
const DEPTH = num('depth', 4);
const MAX = num('max-screens', 60);
const [W, H] = opt('viewport', '1280x800').split('x').map(Number);
// Never press anything that could destroy state, spend money or send something.
// Matched against the control's text AND its aria-label; extend for your
// product's own words (and its language) before crawling a real deployment.
const SKIP =
  /delete|remove|reset|sign ?out|log ?out|clear|discard|archiv|trash|revoke|deactivat|disabl|unpublish|purge|empty|cancel subscription|leave|pay\b|checkout|submit|approve|видали|вилучи|очист|скасув|löschen|entfernen|supprimer|eliminar/i;
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
const overlayVersion = await page.evaluate(() => window.__fp?.version || 0);
if (!overlayVersion) {
  console.error('this deployment runs an overlay without the screen-label hook (pre-v2) — the map cannot be built from it');
  await browser.close();
  process.exit(1);
}
const label = () => page.evaluate(() => window.__fp.label());
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
      const label = (el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const txt = ((el.textContent || '').replace(/\s+/g, ' ').trim() || label).slice(0, 60);
      out.push({ txt, label, x: r.left + r.width / 2, y: r.top + r.height / 2 });
    }
    return out;
  });

const showOverlay = (on) =>
  page.evaluate((v) => {
    const h = document.querySelector('[data-fp-host]');
    if (h) h.style.visibility = v;
  }, on ? '' : 'hidden');

const origin = new URL(url).origin;
const onOrigin = () => {
  try {
    return new URL(page.url()).origin === origin;
  } catch {
    return false;
  }
};

const shoot = async (lbl) => {
  // The map wants the prototype, not the comment UI on top of it. Restore the
  // overlay even if the shot fails — otherwise the rest of the crawl is blind.
  if (!onOrigin()) return false; // never screenshot or post to a foreign site
  let buf;
  await showOverlay(false);
  try {
    buf = await page.screenshot({ type: 'jpeg', quality: 80 });
  } catch {
    return false;
  } finally {
    await showOverlay(true).catch(() => {});
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
    if (!onOrigin()) {
      await page.goto(url); // that control left the site
      return false;
    }
  }
  // Repeated control texts ("View", "Open") make the wrong element easy to hit:
  // a branch that does not land where it did the first time is not this branch.
  const want = expectedFor.get(JSON.stringify(path));
  if (want && (await label()) !== want) return false;
  return true;
};

const seen = new Map(); // label → path
const expectedFor = new Map(); // JSON(path) → label the path is supposed to reach
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
  const cs = (await controls()).filter((c) => c.txt && !SKIP.test(c.txt) && !SKIP.test(c.label || ''));
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
    if (!onOrigin()) {
      await page.goto(url); // the click left the site
      dirty = false;
      continue;
    }
    if (to !== from) {
      dirty = true;
      if (!seen.has(to)) {
        seen.set(to, [...path, c]);
        expectedFor.set(JSON.stringify([...path, c]), to);
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
