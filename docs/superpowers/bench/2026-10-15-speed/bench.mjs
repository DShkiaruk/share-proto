// Before/after: the overlay as it was before the speed work (8f1b8e3) against
// the current one (v2 HEAD), on the same three pages, by the same steps:
//   heavy    — tests/fixtures/heavy.html (600 rows, live countdowns)
//   report   — a real client's competitor report (5.4 MB, 36 lazy pictures)
//   app      — a real client's app prototype (0.7 MB, one page)
// The two real pages are client work and stay out of this repo: setup.sh
// takes their paths. Without them only "heavy" is built and measured.
// Each run gets its own server and an empty store.
//   bash setup.sh [report.html] [app.html] [app-assets-dir]
//   node bench.mjs post|slowread|idle|scroll [reps]
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { rmSync, appendFileSync, existsSync } from 'node:fs';

const V = new URL('.', import.meta.url).pathname;
const OUT = V + (process.env.RESULTS || 'results.jsonl');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = { old: { heavy: 4611, report: 4612, app: 4613 }, new: { heavy: 4621, report: 4622, app: 4623 }, next: { heavy: 4631, report: 4632, app: 4633 } };
// Which builds to compare: site-<version>-<page>. `next` is any third build.
const VERSIONS = (process.env.VERSIONS || 'old,new').split(',');
const POINT = { heavy: { x: 700, y: 420 }, report: { x: 700, y: 380 }, app: { x: 700, y: 380 } };
const record = (o) => {
  console.log(JSON.stringify(o));
  appendFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n');
};

async function server(v, p) {
  const dir = `${V}site-${v}-${p}`;
  const port = PORT[v][p];
  rmSync(`${dir}/data`, { recursive: true, force: true });
  const proc = spawn('node', ['server.js', '--port', String(port)], {
    cwd: dir,
    env: { ...process.env, DESIGNER_PASSWORD: 'team-b', CLIENT_PASSWORD: 'client-b', SESSION_SECRET: 'bench-secret' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://localhost:${port}/login.html`);
      break;
    } catch {}
    await sleep(100);
  }
  return { base: `http://localhost:${port}`, stop: () => proc.kill() };
}

async function login(page, base, name, pass, path = '/') {
  await page.goto(base + path);
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Password').fill(pass);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForFunction(() => Boolean(window.__fp?.state.role), null, { timeout: 60_000 });
  if (path !== '/') await page.goto(base + path), await page.waitForFunction(() => Boolean(window.__fp?.state.role));
}

const sr = (page, sel) => page.locator(`[data-fp-host] >> ${sel}`);
async function realClick(page, loc) {
  const b = await loc.boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}
async function taskSeconds(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return metrics.find((m) => m.name === 'TaskDuration').value;
}

// ---- 1. leave a comment: how long until it shows, how long the page is stuck,
//         how much work it costs, when the picture is saved
const built = (v, p) => existsSync(`${V}site-${v}-${p}`);
async function post(v, p, rate, rep) {
  if (!built(v, p)) return;
  const s = await server(v, p);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  try {
    await login(page, s.base, 'Client', 'client-b');
    await page.waitForTimeout(1500);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    // what the page costs doing nothing, to tell when the comment's work is over
    const i0 = await taskSeconds(cdp);
    await page.waitForTimeout(2000);
    const idleRate = ((await taskSeconds(cdp)) - i0) / 2;
    await page.evaluate(() => {
      window.__long = [];
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ type: 'longtask' });
    });
    const text = `bench ${v} ${p} ${rate}x #${rep}`;
    await realClick(page, sr(page, '.tb-btn').first());
    await page.mouse.click(POINT[p].x, POINT[p].y);
    const ta = sr(page, '.popover textarea');
    await ta.waitFor({ state: 'visible', timeout: 30_000 });
    await ta.fill(text);
    // when the comment is drawn, timed inside the page: from the Enter key to
    // the first frame that has it (the outside check can only look once the
    // page is free again, so it also counts any freeze that follows)
    await page.evaluate((text) => {
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
    const w0 = await taskSeconds(cdp);
    const t0 = Date.now();
    await page.keyboard.press('Enter');
    await sr(page, '.popover .msg').filter({ hasText: text }).waitFor({ timeout: 60_000 });
    const shown = Date.now() - t0;
    // the picture: read the store from outside the page, so the reading adds no work to it
    let preview = null;
    let settled = null;
    let last = await taskSeconds(cdp);
    let lastAt = Date.now();
    const CAP = 45_000;
    while (Date.now() - t0 < CAP) {
      await sleep(250);
      if (preview === null) {
        const j = await (await ctx.request.get(s.base + '/api/comments')).json();
        if (j.threads.find((t) => t.messages[0].text === text)?.preview) preview = Date.now() - t0;
      }
      const now = Date.now();
      if (now - lastAt >= 1000) {
        const cur = await taskSeconds(cdp);
        const r = (cur - last) / ((now - lastAt) / 1000);
        if (r <= idleRate * 1.5 + 0.05 && settled === null && Date.now() - t0 > 1500) settled = lastAt - t0;
        if (r > idleRate * 1.5 + 0.05) settled = null;
        last = cur;
        lastAt = now;
      }
      if (preview !== null && settled !== null) break;
    }
    const work = (await taskSeconds(cdp)) - w0 - idleRate * ((Date.now() - t0) / 1000);
    const longs = await page.evaluate(() => window.__long);
    const tt = await page.evaluate(() => window.__t);
    record({
      test: 'post', v, p, rate, rep,
      drawnMs: tt.frame ? Math.round(tt.frame - tt.key) : null,
      shownMs: shown,
      previewMs: preview, // null = never saved within 45 s
      busyUntilMs: settled ?? `>${CAP}`,
      extraWorkS: +work.toFixed(2),
      longestFreezeMs: Math.round(Math.max(0, ...longs)),
      frozenTotalMs: Math.round(longs.reduce((a, b) => a + b, 0)),
    });
  } catch (e) {
    record({ test: 'post', v, p, rate, rep, error: String(e).slice(0, 200) });
  } finally {
    await browser.close();
    s.stop();
  }
}

// ---- 2. the same, while the store answers reads slowly (a cold serverless
//         function): does the comment wait for a second full read?
async function slowread(v, p, rep) {
  if (!built(v, p)) return;
  const s = await server(v, p);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  try {
    await login(page, s.base, 'Client', 'client-b');
    await page.waitForTimeout(1000);
    await page.route('**/api/comments', async (route) => {
      if (route.request().method() === 'GET') await sleep(2000);
      await route.continue();
    });
    const text = `slow ${v} ${p} #${rep}`;
    await realClick(page, sr(page, '.tb-btn').first());
    await page.mouse.click(POINT[p].x, POINT[p].y);
    const ta = sr(page, '.popover textarea');
    await ta.waitFor({ state: 'visible' });
    await ta.fill(text);
    const t0 = Date.now();
    await page.keyboard.press('Enter');
    await sr(page, '.popover .msg').filter({ hasText: text }).waitFor({ timeout: 30_000 });
    record({ test: 'slowread', v, p, rep, shownMs: Date.now() - t0 });
  } catch (e) {
    record({ test: 'slowread', v, p, rep, error: String(e).slice(0, 200) });
  } finally {
    await browser.close();
    s.stop();
  }
}

// ---- 3. a reviewer left the tab open for 20 minutes; someone else comments;
//         the reviewer clicks on the page. How long until they see it?
//         The reviewer's clock is fake and stepped, so 20 minutes take seconds.
async function idle(v, rep, how = 'click') {
  const p = 'heavy';
  const s = await server(v, p);
  const browser = await chromium.launch();
  try {
    const a = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pa = await a.newPage();
    await pa.clock.install();
    await login(pa, s.base, 'Designer', 'team-b');
    for (let i = 0; i < 40; i++) {
      await pa.clock.fastForward(30_000);
      await pa.waitForTimeout(150);
    }
    const every = await pa.evaluate(() => window.__fp.pollEvery);
    const b = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pb = await b.newPage();
    await login(pb, s.base, 'Client', 'client-b');
    const text = `idle ${v} #${rep}`;
    const status = await pb.evaluate(async (text) => {
      const st = window.__fp.state;
      const r = await window.__fp.api('POST', { action: 'create', text, screen: st.screen, screenLabel: st.screenLabel, page: location.pathname, trail: [],
        anchor: { path: 'body', t: 'body', txt: '', ox: 0.5, oy: 0.3, fx: 0.5, fy: 0.3, container: null } });
      return Boolean(r?.thread);
    }, text);
    // the reviewer is back: a click on the page, or the window coming to the
    // front from another app
    if (how === 'click') await pa.mouse.click(1240, 60);
    else await pa.evaluate(() => window.dispatchEvent(new Event('focus')));
    const sees = () => pa.evaluate((t) => window.__fp.state.threads.some((x) => x.messages?.[0]?.text === t), text);
    let secs = null;
    for (let i = 0; i <= 300; i++) {
      await pa.waitForTimeout(120);
      if (await sees()) { secs = i; break; }
      await pa.clock.fastForward(1000);
    }
    record({ test: `idle-${how}`, v, rep, posted: status, pollEveryS: every / 1000, seenAfterS: secs ?? '>300' });
  } catch (e) {
    record({ test: `idle-${how}`, v, rep, error: String(e).slice(0, 200) });
  } finally {
    await browser.close();
    s.stop();
  }
}

// ---- 4. 40 comments on a long page: what the overlay costs at rest and while
//         scrolling, on a slow CPU (4x)
async function scroll(v, rep, phone = false) {
  const p = 'heavy';
  const s = await server(v, p);
  const browser = await chromium.launch();
  try {
    const opts = phone
      ? { viewport: { width: 412, height: 839 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true }
      : { viewport: { width: 1280, height: 800 } };
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    await login(page, s.base, 'Designer', 'team-b');
    await page.evaluate(async () => {
      const st = window.__fp.state;
      for (let k = 1; k <= 80; k += 2) {
        await window.__fp.api('POST', { action: 'create', text: `pin ${k}`, screen: st.screen, screenLabel: st.screenLabel, page: location.pathname, trail: [],
          anchor: { path: `#root > div > main > div.list > div:nth-of-type(${k})`, t: 'div', txt: '', ox: 0.3 + (k % 5) / 10, oy: 0.5, fx: 0.5, fy: 0.1, container: null } });
      }
    });
    await page.reload();
    await page.waitForFunction(() => Boolean(window.__fp?.state.role));
    await page.waitForTimeout(2000);
    const pins = await page.evaluate(() => document.querySelector('[data-fp-host]').shadowRoot.querySelectorAll('.pins .pin:not(.draft)').length);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.waitForTimeout(1000);
    // at rest
    const r0 = await taskSeconds(cdp);
    await page.waitForTimeout(10_000);
    const restPerS = ((await taskSeconds(cdp)) - r0) / 10;
    // scrolling down and back up
    await page.evaluate(() => {
      window.__frames = [];
      let last = performance.now();
      const f = (t) => { window.__frames.push(t - last); last = t; if (window.__frames.length < 100000) window.__raf = requestAnimationFrame(f); };
      window.__raf = requestAnimationFrame(f);
    });
    await page.mouse.move(700, 400);
    const s0 = await taskSeconds(cdp);
    const t0 = Date.now();
    for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, 90); await page.waitForTimeout(30); }
    for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, -90); await page.waitForTimeout(30); }
    await page.waitForTimeout(300);
    const scrollS = (Date.now() - t0) / 1000;
    const scrollWork = (await taskSeconds(cdp)) - s0;
    const fr = await page.evaluate(() => { cancelAnimationFrame(window.__raf); return window.__frames.slice(1); });
    fr.sort((a, b) => a - b);
    const q = (x) => Math.round(fr[Math.min(fr.length - 1, Math.floor(fr.length * x))]);
    record({
      test: phone ? 'scroll-phone' : 'scroll', v, rep, pins,
      restCpuPct: +(restPerS * 100).toFixed(1),
      scrollCpuPct: +((scrollWork / scrollS) * 100).toFixed(1),
      frames: fr.length, frameP50: q(0.5), frameP95: q(0.95), frameMax: Math.round(fr[fr.length - 1]),
      jank50: fr.filter((x) => x > 50).length,
    });
  } catch (e) {
    record({ test: phone ? 'scroll-phone' : 'scroll', v, rep, error: String(e).slice(0, 200) });
  } finally {
    await browser.close();
    s.stop();
  }
}

const [what, repsArg] = process.argv.slice(2);
const reps = Number(repsArg || 3);
for (let rep = 1; rep <= reps; rep++) {
  for (const v of VERSIONS) {
    if (what === 'post') for (const p of ['heavy', 'report', 'app']) for (const rate of [1, 4]) await post(v, p, rate, rep);
    if (what === 'post1') for (const p of process.argv.slice(4)) await post(v, p, 1, rep);
    if (what === 'slowread') for (const p of ['heavy', 'app']) await slowread(v, p, rep);
    if (what === 'idle') { await idle(v, rep); await idle(v, rep, 'focus'); }
    if (what === 'scroll') { await scroll(v, rep); await scroll(v, rep, true); }
  }
}
