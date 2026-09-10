import { test, expect } from '@playwright/test';
import { login, mouseClick, inOverlay, apiGet, openList } from './helpers.mjs';

const TEAM = 'team-e2e';

// Reported from a live review: "comments don't know which state they were put
// in — the dark or the light theme of the prototype". A screen is not one
// picture, so the comment has to carry the one it was left on.
test.describe.configure({ mode: 'serial' });

test('a comment remembers the theme it was left in, and can put it back', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await page.click('#theme'); // the prototype's own toggle → data-theme="dark"
  await expect.poll(() => page.evaluate(() => window.__fp.state.theme)).toBe('dark');

  await mouseClick(page, inOverlay(page, '.tb-btn').first()); // Comment
  await page.mouse.click(420, 300);
  const ta = inOverlay(page, '.popover textarea');
  await expect(ta).toBeVisible();
  await ta.fill('unreadable on this background');
  await page.keyboard.press('Enter');
  await expect(inOverlay(page, '.popover .msg .text').filter({ hasText: 'unreadable' })).toBeVisible({
    timeout: 10_000,
  });

  const { threads } = await apiGet(page, '/api/comments');
  const made = threads.find((t) => t.messages[0].text === 'unreadable on this background');
  expect(made.theme.mode).toBe('dark');
  // The marks are what makes it restorable, not just describable.
  expect(made.theme.marks.html.attrs['data-theme']).toBe('dark');

  // Back to light: the thread now says where it came from, and offers the way.
  await page.keyboard.press('Escape');
  await page.click('#theme');
  await expect.poll(() => page.evaluate(() => window.__fp.state.theme)).toBe('light');
  await openList(page);
  await mouseClick(page, inOverlay(page, '.sb-row').filter({ hasText: 'unreadable' }).first());
  const tag = inOverlay(page, '.popover .theme-tag');
  await expect(tag).toHaveText('Left in dark mode');

  await mouseClick(page, tag);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => page.evaluate(() => window.__fp.state.theme)).toBe('dark');
  // Nothing left to offer once the prototype matches.
  await expect(inOverlay(page, '.popover .theme-tag')).toHaveCount(0);

  await page.click('#theme'); // leave the fixture light for whatever runs next
  await expect.poll(() => page.evaluate(() => window.__fp.state.theme)).toBe('light');
});

test('a comment left in the theme you are already in says nothing about it', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await openList(page);
  await mouseClick(page, inOverlay(page, '.sb-row').filter({ hasText: 'unreadable' }).first());
  await expect(inOverlay(page, '.popover')).toBeVisible();
  await expect(inOverlay(page, '.popover .theme-tag')).toHaveText('Left in dark mode');

  // ...and the reverse: this one was left in light, and we are in light.
  await page.keyboard.press('Escape');
  await mouseClick(page, inOverlay(page, '.tb-btn').first());
  await page.mouse.click(420, 260);
  const ta = inOverlay(page, '.popover textarea');
  await ta.fill('left in the light theme');
  await page.keyboard.press('Enter');
  await expect(inOverlay(page, '.popover .msg .text').filter({ hasText: 'light theme' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(inOverlay(page, '.popover .theme-tag')).toHaveCount(0);
});
