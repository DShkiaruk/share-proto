import { test, expect } from '@playwright/test';
import { login, mouseClick, inOverlay, apiGet } from './helpers.mjs';

const TEAM = 'team-e2e';
const CLIENT = 'client-e2e';
test.describe.configure({ mode: 'serial' });

// Width/height from the first SOFn marker of a baseline/progressive JPEG.
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

test('a posted comment gets a viewport preview; the client cannot fetch a designer preview', async ({ page, browser }) => {
  await login(page, 'Designer', TEAM);
  await mouseClick(page, inOverlay(page, '.tb-btn').first());
  await mouseClick(page, page.locator('section[data-route="home"] h1'));
  await inOverlay(page, '.popover textarea').fill('with preview');
  await page.keyboard.press('Enter');
  await expect(inOverlay(page, '.popover .msg .text').filter({ hasText: 'with preview' })).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(async () => (await apiGet(page, '/api/comments')).threads.find((t) => t.messages[0].text === 'with preview')?.preview, {
      timeout: 15_000,
    })
    .toMatch(/^previews\//);
  const t = (await apiGet(page, '/api/comments')).threads.find((x) => x.messages[0].text === 'with preview');
  const r = await page.request.get(`/api/file?p=${encodeURIComponent(t.preview)}`);
  expect(r.status()).toBe(200);
  expect(r.headers()['content-type']).toBe('image/jpeg');
  const body = await r.body();
  expect(body.length).toBeGreaterThan(1000);
  // It is a *viewport* capture: 1280×800 scaled to ≤ 960 px wide → 960×600 (JPEG SOF0 frame header).
  expect(jpegSize(body)).toEqual({ w: 960, h: 600 });
  const client = await browser.newPage();
  await login(client, 'Client', CLIENT);
  expect((await client.request.get(`/api/file?p=${encodeURIComponent(t.preview)}`)).status()).toBe(404);
});

test('an image attached via the paperclip is stored, rendered and opens a lightbox', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await mouseClick(page, inOverlay(page, '.tb-btn').first());
  await mouseClick(page, page.locator('section[data-route="home"] p').first());
  await inOverlay(page, '.attach-input').setInputFiles('tests/fixtures/pixel.png');
  await expect(inOverlay(page, '.attach-strip .thumb')).toHaveCount(1);
  await inOverlay(page, '.popover textarea').fill('see attached');
  await page.keyboard.press('Enter');
  const img = inOverlay(page, '.popover .msg .imgs img');
  await expect(img).toBeVisible({ timeout: 10_000 });
  const t = (await apiGet(page, '/api/comments')).threads.find((x) => x.messages[0].text === 'see attached');
  expect(t.messages[0].img[0]).toMatch(/^attach\//);
  await mouseClick(page, img);
  await expect(inOverlay(page, '.lightbox img')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(inOverlay(page, '.lightbox')).toHaveCount(0);
});

test('hovering a sidebar row shows the preview card', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await mouseClick(page, inOverlay(page, '.tb-btn').nth(1));
  const row = inOverlay(page, '.sb-row').filter({ hasText: 'with preview' });
  const box = await row.boundingBox();
  await page.mouse.move(box.x + 40, box.y + 10);
  const card = inOverlay(page, '.preview-card');
  await expect(card).toBeVisible({ timeout: 3000 });
  await expect(card.locator('img')).toHaveAttribute('src', /api\/file\?p=previews/);
  await page.mouse.move(5, 5);
  await expect(card).toHaveCount(0);
});
