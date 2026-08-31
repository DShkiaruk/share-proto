export function requireEnv() {
  for (const k of ['LAB_URL', 'LAB_TEAM', 'LAB_CLIENT']) {
    if (!process.env[k]) throw new Error(`Set ${k} (see ~/filepig-lab/.passwords.local for the lab)`);
  }
}

export async function login(page, name, password) {
  await page.goto('/');
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForSelector('[data-fp-host]', { timeout: 15_000 });
  // The toolbar changes width when the first poll lands (the thread count
  // appears), so clicking by coordinates before that is aiming at a moving
  // target. Wait until the overlay has its data.
  await page.waitForFunction(() => Boolean(window.__fp?.state.role), null, { timeout: 15_000 });
}

// Click by real coordinates: the overlay's click-layer swallows synthetic
// clicks. Scroll first so the box is inside the viewport.
export async function mouseClick(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('element not visible');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

export const shadow = (page) => page.locator('[data-fp-host]');
export const inOverlay = (page, selector) => page.locator(`[data-fp-host] >> ${selector}`);

export async function apiGet(page, path) {
  return page.evaluate(async (p) => (await fetch(p)).json(), path);
}

export async function apiPost(page, body) {
  return page.evaluate(
    async (b) =>
      (
        await fetch('/api/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(b),
        })
      ).status,
    body
  );
}
