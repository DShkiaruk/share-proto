import { chromium } from '@playwright/test';
const b = await chromium.launch();
for (const scheme of ['light', 'dark']) {
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  await p.goto('http://localhost:4173/');
  await p.getByLabel('Your name').fill('Dima');
  await p.getByLabel('Password').fill('team-e2e');
  await p.getByRole('button', { name: 'Continue' }).click();
  await p.waitForFunction(() => Boolean(window.__fp?.state.role));
  await p.waitForTimeout(400);
  if (scheme === 'dark') { await p.click('#theme'); await p.waitForTimeout(600); }
  await p.keyboard.press('c'); await p.mouse.click(420, 300); await p.waitForTimeout(500);
  await p.locator('[data-fp-host] >> .popover textarea').fill('fill check');
  await p.keyboard.press('Enter'); await p.waitForTimeout(1500);
  const r = await p.evaluate(() => {
    const sr = document.querySelector('[data-fp-host]').shadowRoot;
    const st = getComputedStyle(sr.querySelector('.popover .status'));
    return { statusBg: st.backgroundColor, statusH: sr.querySelector('.popover .status').getBoundingClientRect().height };
  });
  const so = await p.evaluate(() => {
    const sr = document.querySelector('[data-fp-host]').shadowRoot;
    const el = sr.querySelector('.sort');
    return el ? { sortBg: getComputedStyle(el).backgroundColor, sortH: el.getBoundingClientRect().height } : null;
  });
  // open the list so the sort control exists
  const tb = await p.locator('[data-fp-host] >> .tb-btn').filter({ hasText: 'Threads' }).boundingBox();
  await p.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2);
  await p.waitForTimeout(700);
  const so2 = await p.evaluate(() => {
    const sr = document.querySelector('[data-fp-host]').shadowRoot;
    const el = sr.querySelector('.sort');
    return { sortBg: getComputedStyle(el).backgroundColor, sortH: el.getBoundingClientRect().height };
  });
  console.log(scheme, '| status', r.statusBg, r.statusH, '| sort', so2.sortBg, so2.sortH,
    r.statusBg === so2.sortBg && r.statusH === so2.sortH ? 'MATCH' : '*** MISMATCH ***');
  await p.close();
}
await b.close();
