// v2.9.0 on a real Vercel deployment (the lab): does asking come from the CDN,
// does a quiet tab stop reading, and how soon does a designer at the page see
// a client's comment — after one click, and with no click at all.
// Every comment made here is deleted at the end.
//   LAB_URL=… LAB_TEAM=… LAB_CLIENT=… node live-lab.mjs
import { chromium } from '@playwright/test';
import { appendFileSync } from 'node:fs';

for (const k of ['LAB_URL', 'LAB_TEAM', 'LAB_CLIENT']) if (!process.env[k]) throw new Error(`Set ${k}`);
const BASE = process.env.LAB_URL.replace(/\/$/, '');
const OUT = new URL('live-lab.jsonl', import.meta.url).pathname;
const record = (o) => {
  console.log(JSON.stringify(o));
  appendFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(page, name, pass) {
  await page.goto(BASE + '/');
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Password').fill(pass);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForFunction(() => Boolean(window.__fp?.state.role), null, { timeout: 60_000 });
}

const browser = await chromium.launch();
const d = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const c = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const made = [];
const net = { asks: [], reads: 0 };
d.on('response', (r) => {
  const u = new URL(r.url());
  if (u.pathname === '/api/version') net.asks.push({ t: Date.now(), cache: r.headers()['x-vercel-cache'] || '-', status: r.status() });
  if (u.pathname === '/api/comments' && r.request().method() === 'GET') net.reads++;
});
const sees = (text) => d.evaluate((t) => window.__fp.state.threads.some((x) => x.messages?.[0]?.text === t), text);
async function post(text) {
  return c.evaluate(async (text) => {
    const st = window.__fp.state;
    const { thread } = await window.__fp.api('POST', { action: 'create', text, screen: st.screen, screenLabel: st.screenLabel, page: location.pathname, trail: [],
      anchor: { path: 'body', t: 'body', txt: '', ox: 0.5, oy: 0.4, fx: 0.5, fy: 0.4, container: null } });
    return thread.id;
  }, text);
}
try {
  await login(d, 'Live check (team)', process.env.LAB_TEAM);
  await login(c, 'Live check (client)', process.env.LAB_CLIENT);
  record({ test: 'mode', changes: await d.evaluate(() => window.__fp.changes) });

  // 1. a quiet minute: asks only, from the CDN, no reads
  await sleep(4000);
  const a0 = net.asks.length;
  const r0 = net.reads;
  for (let i = 0; i < 6; i++) {
    await d.mouse.move(600 + i * 10, 400); // presence without clicking anything
    await d.evaluate(() => window.__fp.ask());
    await sleep(10_000);
  }
  const quiet = net.asks.slice(a0);
  record({ test: 'quiet minute', asks: quiet.length, cache: quiet.map((x) => x.cache).join(' '), fullReads: net.reads - r0 });

  // 2. a client comments; the designer clicks once, 2 s later
  for (let rep = 1; rep <= 3; rep++) {
    const text = `v2.9 live check ${rep} — to be deleted`;
    await d.evaluate(() => window.__fp.schedule(10 * 60 * 1000)); // only the click may find it
    await sleep(3500);
    const t0 = Date.now();
    made.push(await post(text));
    const saved = Date.now() - t0;
    await sleep(2000);
    const t1 = Date.now();
    await d.mouse.click(1200, 520); // blank page, right of the content
    let seen = null;
    while (Date.now() - t1 < 15_000) {
      if (await sees(text)) { seen = Date.now() - t1; break; }
      await sleep(50);
    }
    record({ test: 'one click', rep, savedMs: saved, seenAfterClickMs: seen });
  }

  // 3. no click at all: the steady 15 s ask finds it
  for (let rep = 1; rep <= 2; rep++) {
    const text = `v2.9 live check, no click ${rep} — to be deleted`;
    await d.evaluate(() => window.__fp.schedule(15_000));
    await sleep(1000);
    const t0 = Date.now();
    made.push(await post(text));
    let seen = null;
    while (Date.now() - t0 < 40_000) {
      if (await sees(text)) { seen = Date.now() - t0; break; }
      await sleep(100);
    }
    record({ test: 'no click', rep, seenMs: seen });
  }
} catch (e) {
  record({ test: 'error', error: String(e).slice(0, 300) });
} finally {
  for (const id of made) await d.evaluate((id) => window.__fp.api('POST', { action: 'delete', threadId: id }).catch(() => null), id);
  const left = await d.evaluate(async () => (await (await fetch('/api/comments')).json()).threads.filter((t) => /v2\.9 live check/.test(t.messages[0].text)).length);
  record({ test: 'cleanup', deleted: made.length, leftOver: left });
  await browser.close();
}
