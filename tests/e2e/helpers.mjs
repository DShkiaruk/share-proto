export async function login(page, name, password) {
  await page.goto('/');
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForSelector('[data-fp-host]', { timeout: 15_000 });
}

// Click by real coordinates: the overlay's click-layer swallows synthetic clicks.
export async function mouseClick(page, locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element not visible');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

export const shadow = (page) => page.locator('[data-fp-host]');
export const inOverlay = (page, selector) => page.locator(`[data-fp-host] >> ${selector}`);

export async function apiGet(page, path) {
  return page.evaluate(async (p) => (await fetch(p)).json(), path);
}
