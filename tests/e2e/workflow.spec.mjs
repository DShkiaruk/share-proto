import { test, expect } from '@playwright/test';
import { login, mouseClick, inOverlay, apiGet, apiPost } from './helpers.mjs';

const TEAM = 'team-e2e';
const CLIENT = 'client-e2e';
test.describe.configure({ mode: 'serial' });

const threadsOf = async (page) => (await apiGet(page, '/api/comments')).threads;
const openFirst = async (page) => {
  await mouseClick(page, inOverlay(page, '.tb-btn').nth(1)); // Threads
  await inOverlay(page, 'select.sort').selectOption('oldest');
  await mouseClick(page, inOverlay(page, '.sb-row').first());
  await expect(inOverlay(page, '.popover')).toBeVisible();
};

test('designer sets In progress and Won’t do (with a required reason); system lines appear', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await openFirst(page);
  await mouseClick(page, inOverlay(page, '.popover .status'));
  await mouseClick(page, inOverlay(page, '.status-menu button').filter({ hasText: 'In progress' }));
  await expect(inOverlay(page, '.popover .status')).toHaveText('In progress', { timeout: 10_000 });
  await expect(inOverlay(page, '.popover .sys-line').filter({ hasText: 'In progress' })).toBeVisible();

  await mouseClick(page, inOverlay(page, '.popover .status'));
  await mouseClick(page, inOverlay(page, '.status-menu button').filter({ hasText: "Won’t do" }));
  const save = inOverlay(page, '.wont-note button');
  await expect(save).toBeDisabled();
  await inOverlay(page, '.wont-note textarea').fill('Out of scope for v1');
  await mouseClick(page, save);
  await expect(inOverlay(page, '.popover .status')).toHaveText("Won’t do", { timeout: 10_000 });
  const t = (await threadsOf(page)).find((x) => x.n === 1);
  expect(t.status).toBe('wont');
  expect(t.statusNote).toBe('Out of scope for v1');
  expect(t.resolved).toBe(true);
});

test('a client may only toggle Open/Done; progress is refused by the server', async ({ page }) => {
  await login(page, 'Client', CLIENT);
  const mine = (await threadsOf(page)).find((x) => x.authorRole === 'client');
  expect(await apiPost(page, { action: 'status', threadId: mine.id, status: 'progress' })).toBe(403);
  expect(await apiPost(page, { action: 'status', threadId: mine.id, status: 'done' })).toBe(200);
  expect((await threadsOf(page)).find((x) => x.id === mine.id).status).toBe('done');
  expect(await apiPost(page, { action: 'status', threadId: mine.id, status: 'open' })).toBe(200);
  await mouseClick(page, inOverlay(page, '.tb-btn').nth(1));
  await mouseClick(page, inOverlay(page, '.sb-row').first());
  await mouseClick(page, inOverlay(page, '.popover .status'));
  await expect(inOverlay(page, '.status-menu button')).toHaveCount(2); // Open, Done
});

test('reactions toggle on and off', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await mouseClick(page, inOverlay(page, '.tb-btn').nth(1));
  await inOverlay(page, 'select.sort').selectOption('oldest');
  await inOverlay(page, '.seg button').filter({ hasText: 'All' }).click();
  await mouseClick(page, inOverlay(page, '.sb-row').nth(1));
  await mouseClick(page, inOverlay(page, '.popover .react-add').first());
  await mouseClick(page, inOverlay(page, '.react-palette button').filter({ hasText: '👍' }));
  const chip = inOverlay(page, '.popover .react-chip').filter({ hasText: '👍' });
  await expect(chip).toHaveText(/👍\s*1/, { timeout: 10_000 });
  await expect(chip).toHaveClass(/mine/);
  await mouseClick(page, chip);
  await expect(inOverlay(page, '.popover .react-chip').filter({ hasText: '👍' })).toHaveCount(0, { timeout: 10_000 });
});

test('kind chips at creation; status filter; versions registered and labeled', async ({ page }) => {
  await login(page, 'Designer', TEAM);
  await mouseClick(page, inOverlay(page, '.tb-btn').first());
  await mouseClick(page, page.locator('section[data-route="home"] p').first());
  await mouseClick(page, inOverlay(page, '.kind-chip').filter({ hasText: 'Bug' }));
  await inOverlay(page, '.popover textarea').fill('a bug report');
  await page.keyboard.press('Enter');
  await expect(inOverlay(page, '.popover .msg .text').filter({ hasText: 'a bug report' })).toBeVisible({ timeout: 10_000 });
  const t = (await threadsOf(page)).find((x) => x.messages[0].text === 'a bug report');
  expect(t.kind).toBe('bug');
  await expect(inOverlay(page, '.popover .kind-ico')).toBeVisible();

  await page.keyboard.press('Escape');
  await mouseClick(page, inOverlay(page, '.tb-btn').nth(1));
  await inOverlay(page, '.seg button').filter({ hasText: "Won’t do" }).click();
  await expect(inOverlay(page, '.sb-row')).toHaveCount(1);
  await inOverlay(page, '.seg button').filter({ hasText: 'All' }).click();
  const all = (await threadsOf(page)).length;
  await expect(inOverlay(page, '.sb-row')).toHaveCount(all);

  const { versions } = await apiGet(page, '/api/comments');
  expect(versions.length).toBeGreaterThanOrEqual(1);
  const proto = await page.evaluate(() => window.__fp.state.proto);
  expect(versions.some((v) => v.id === proto)).toBe(true);
  expect(await apiPost(page, { action: 'version-label', id: proto, label: 'Sprint 12' })).toBe(200);
  await mouseClick(page, inOverlay(page, '.sb-versions'));
  await expect(inOverlay(page, '.versions .ver-label').filter({ hasText: 'Sprint 12' })).toBeVisible();
});

test('what’s new: a client comment since the last visit shows a New badge for the designer', async ({ page, browser }) => {
  await login(page, 'Designer', TEAM);
  // Simulate a previous visit a minute ago and a *new* browser session (the digest is session-scoped).
  await page.evaluate(() => {
    localStorage.setItem('fp_last_visit', String(Date.now() - 60_000));
    sessionStorage.removeItem('fp_session');
  });
  const client = await browser.newPage();
  await login(client, 'Client', CLIENT);
  await mouseClick(client, inOverlay(client, '.tb-btn').first());
  await mouseClick(client, client.locator('section[data-route="home"] h1'));
  await inOverlay(client, '.popover textarea').fill('client news');
  await client.keyboard.press('Enter');
  await expect(inOverlay(client, '.popover .msg .text').filter({ hasText: 'client news' })).toBeVisible({ timeout: 10_000 });
  await page.reload();
  await page.waitForSelector('[data-fp-host]');
  await expect(inOverlay(page, '.tb-btn').nth(1)).toContainText(/new/i, { timeout: 10_000 });
  await mouseClick(page, inOverlay(page, '.tb-btn').nth(1));
  await expect(inOverlay(page, '.sb-group').filter({ hasText: 'New for you' })).toBeVisible();
  await expect(inOverlay(page, '.sb-row.new').filter({ hasText: 'client news' })).toBeVisible();
});
