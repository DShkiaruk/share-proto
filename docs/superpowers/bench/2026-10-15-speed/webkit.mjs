// The same before/after (see bench.mjs, setup.sh) in Safari's engine: no long-task API, so a heartbeat — a 16 ms timer — and the
// longest gap between its beats is the longest the page was stuck.
import { webkit, devices } from '@playwright/test';
import { spawn } from 'node:child_process';
import { rmSync, appendFileSync, existsSync } from 'node:fs';
const V = new URL('.', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = { old: { heavy: 4611, report: 4612, app: 4613 }, new: { heavy: 4621, report: 4622, app: 4623 } };
const sr = (page, sel) => page.locator(`[data-fp-host] >> ${sel}`);
async function run(v, p, phone, rep) {
  if (!existsSync(`${V}site-${v}-${p}`)) return;
  const dir = `${V}site-${v}-${p}`; const port = PORT[v][p];
  rmSync(`${dir}/data`, { recursive: true, force: true });
  const proc = spawn('node', ['server.js', '--port', String(port)], { cwd: dir, env: { ...process.env, DESIGNER_PASSWORD: 'team-b', CLIENT_PASSWORD: 'client-b', SESSION_SECRET: 'bench-secret' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { await fetch(`http://localhost:${port}/login.html`); break; } catch {} await sleep(100); }
  const base = `http://localhost:${port}`;
  const browser = await webkit.launch();
  try {
    const ctx = await browser.newContext(phone ? { ...devices['iPhone 13'] } : { viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(base + '/');
    await page.getByLabel('Your name').fill('Client');
    await page.getByLabel('Password').fill('client-b');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForFunction(() => Boolean(window.__fp?.state.role), null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    const text = `wk ${v} ${p} ${rep}`;
    const b = await sr(page, '.tb-btn').first().boundingBox();
    const tap = (x, y) => (phone ? page.touchscreen.tap(x, y) : page.mouse.click(x, y));
    await tap(b.x + b.width / 2, b.y + b.height / 2);
    await tap(phone ? 200 : 700, phone ? 300 : 420);
    const ta = sr(page, '.popover textarea');
    await ta.waitFor({ state: 'visible', timeout: 30000 });
    await ta.fill(text);
    await page.evaluate(() => {
      window.__gaps = []; let last = performance.now();
      window.__hb = setInterval(() => { const n = performance.now(); window.__gaps.push(n - last); last = n; }, 16);
    });
    const t0 = Date.now();
    if (phone) await sr(page, '.popover .send, .popover button[type=submit], .popover .compose button:last-of-type').first().tap().catch(() => page.keyboard.press('Enter'));
    else await page.keyboard.press('Enter');
    await sr(page, '.popover .msg').filter({ hasText: text }).waitFor({ timeout: 60000 });
    const shown = Date.now() - t0;
    let preview = null;
    while (Date.now() - t0 < 30000) {
      const j = await (await ctx.request.get(base + '/api/comments')).json();
      if (j.threads.find((t) => t.messages[0].text === text)?.preview) { preview = Date.now() - t0; break; }
      await sleep(200);
    }
    await page.waitForTimeout(1500);
    const g = await page.evaluate(() => { clearInterval(window.__hb); return window.__gaps; });
    const o = { test: phone ? 'webkit-iphone' : 'webkit-desk', v, p, rep, shownMs: shown, previewMs: preview, longestStuckMs: Math.round(Math.max(...g) - 16), stuckOver100ms: Math.round(g.filter((x) => x > 100).reduce((a, x) => a + x, 0)) };
    console.log(JSON.stringify(o)); appendFileSync(V + 'results.jsonl', JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n');
  } catch (e) { console.log(v, p, 'error', String(e).slice(0, 200)); }
  finally { await browser.close(); proc.kill(); }
}
for (let rep = 1; rep <= 2; rep++) for (const v of ['old', 'new']) for (const p of ['heavy', 'report']) { await run(v, p, false, rep); await run(v, p, true, rep); }
