import { test, expect } from '@playwright/test';
import { login, mouseClick, inOverlay } from './helpers.mjs';

const TEAM = 'team-e2e';

// The fixture guards Backspace and logs every key it sees outside its own
// inputs — the way a real prototype does. Shadow-DOM retargeting means it
// cannot tell our textarea from our host, so the overlay has to keep its own
// keystrokes to itself.
test.describe.configure({ mode: 'serial' });

test('typing a comment is invisible to the prototype underneath', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await mouseClick(page, inOverlay(page, '.tb-btn').first()); // Comment
  await expect(inOverlay(page, '.click-layer')).toBeVisible();
  await page.mouse.click(500, 420);
  const ta = inOverlay(page, '.popover textarea');
  await expect(ta).toBeVisible();

  await ta.click();
  await page.keyboard.type('abcm');
  await expect(ta).toHaveValue('abcm');

  // Backspace deletes here even though the page cancels it everywhere else.
  await page.keyboard.press('Backspace');
  await expect(ta).toHaveValue('abc');
  await page.keyboard.press('Backspace');
  await expect(ta).toHaveValue('ab');

  // "c" and "m" are the overlay's own shortcuts and the page is watching for
  // keys: neither of them heard a thing.
  expect(await page.evaluate(() => window.__pageKeys)).toEqual([]);
  await expect(inOverlay(page, '.popover textarea')).toBeVisible(); // C did not toggle comment mode
  await expect(inOverlay(page, '.map')).toHaveCount(0); // M did not open the map

  // Escape still reaches the overlay from inside the field.
  await page.keyboard.press('Escape');
  await expect(inOverlay(page, '.popover')).toHaveCount(0);
});

test('shortcuts still work when the focus is on the prototype', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await page.mouse.click(500, 420);
  await page.keyboard.press('c');
  await expect(inOverlay(page, '.click-layer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(inOverlay(page, '.click-layer')).toBeHidden();
});
