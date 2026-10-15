// The lab on Vercel, real network: is it running this code, and how it feels.
// A client leaves a comment; a designer on another computer is at the page.
// Every comment made here is deleted at the end.
//   LAB_URL=… LAB_TEAM=… LAB_CLIENT=… node live.mjs
import { chromium } from '@playwright/test';
import { readFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

for (const k of ['LAB_URL', 'LAB_TEAM', 'LAB_CLIENT']) if (!process.env[k]) throw new Error(`Set ${k}`);
const BASE = process.env.LAB_URL.replace(/\/$/, '');
const TEAM = process.env.LAB_TEAM;
const CLIENT = process.env.LAB_CLIENT;
const OUT = new URL(process.env.RESULTS || 'results.jsonl', import.meta.url).pathname;
const record = (o) => { console.log(JSON.stringify(o)); appendFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), test: 'live', ...o }) + '\n'); };
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const sr = (page, sel) => page.locator(`[data-fp-host] >> ${sel}`);

async function login(page, name, pass) {
  await page.goto(BASE + '/');
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Password').fill(pass);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForFunction(() => Boolean(window.__fp?.state.role), null, { timeout: 60_000 });
}

const browser = await chromium.launch();
const made = [];
const d = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const c = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
try {
  await login(d, 'Live check (team)', TEAM);
  // the code it runs
  for (const f of ['overlay.js', 'overlay.css']) {
    const live = await d.evaluate(async (f) => (await fetch('/' + f, { cache: 'no-store' })).text(), f);
    const here = readFileSync(new URL(`../../../../template/public/${f}`, import.meta.url), 'utf8');
    record({ file: f, same: sha(live) === sha(here), live: sha(live), here: sha(here) });
  }
  await login(c, 'Live check (client)', CLIENT);
  for (let rep = 1; rep <= 3; rep++) {
    await c.waitForTimeout(12_000); // long enough that the designer's last read is "stale"
    const text = `live check ${rep} — to be deleted`;
    await c.evaluate(() => {
      window.__long = [];
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ type: 'longtask' });
    });
    const b = await sr(c, '.tb-btn').first().boundingBox();
    await c.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await c.mouse.click(640 + rep * 30, 420);
    const ta = sr(c, '.popover textarea');
    await ta.waitFor({ state: 'visible' });
    await ta.fill(text);
    await c.evaluate((text) => {
      window.__t = {};
      addEventListener('keydown', (e) => { if (e.key === 'Enter' && !window.__t.key) window.__t.key = performance.now(); }, true);
      const root = document.querySelector('[data-fp-host]').shadowRoot;
      new MutationObserver(() => {
        if (window.__t.dom) return;
        if ([...root.querySelectorAll('.popover .msg')].some((n) => n.textContent.includes(text))) {
          window.__t.dom = performance.now();
          requestAnimationFrame(() => (window.__t.frame = performance.now()));
        }
      }).observe(root, { childList: true, subtree: true });
    }, text);
    const saved = c.waitForResponse((r) => r.url().endsWith('/api/comments') && r.request().method() === 'POST', { timeout: 30_000 });
    const t0 = Date.now();
    await c.keyboard.press('Enter');
    const res = await saved;
    const savedMs = Date.now() - t0;
    const id = (await res.json())?.thread?.id;
    if (id) made.push(id);
    await sr(c, '.popover .msg').filter({ hasText: text }).waitFor({ timeout: 30_000 });
    // the picture, timed from the Enter key while the designer part runs
    const picture = (async () => {
      while (Date.now() - t0 < 30_000) {
        const j = await (await c.context().request.get(BASE + '/api/comments')).json();
        if (j.threads.find((t) => t.id === id)?.preview) return Date.now() - t0;
        await new Promise((r) => setTimeout(r, 300));
      }
      return null;
    })();
    // the designer, at the page: a key press is enough to count as "here"
    const t1 = Date.now();
    await d.keyboard.press('Shift');
    let seenMs = null;
    while (Date.now() - t1 < 60_000) {
      if (await d.evaluate((t) => window.__fp.state.threads.some((x) => x.messages?.[0]?.text === t), text)) { seenMs = Date.now() - t1; break; }
      await d.waitForTimeout(100);
    }
    const previewMs = await picture;
    const tt = await c.evaluate(() => window.__t);
    const longs = await c.evaluate(() => window.__long);
    record({ rep, savedMs, drawnMs: tt.frame ? Math.round(tt.frame - tt.key) : null, previewMs, longestFreezeMs: Math.round(Math.max(0, ...longs)), designerSeesAfterKeyMs: seenMs });
    await c.keyboard.press('Escape');
  }
} catch (e) {
  record({ error: String(e).slice(0, 300) });
} finally {
  for (const id of made) {
    const r = await d.evaluate((id) => window.__fp.api('POST', { action: 'delete', threadId: id }).then(() => 'ok', (e) => String(e)), id);
    record({ deleted: id, r });
  }
  const left = await d.evaluate(async () => (await (await fetch('/api/comments')).json()).threads.filter((t) => /live check/.test(t.messages[0].text)).length);
  record({ leftOver: left });
  await browser.close();
}
