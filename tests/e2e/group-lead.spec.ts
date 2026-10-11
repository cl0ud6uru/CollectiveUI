import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
declare global {
  interface Window { groupTest: { calls: { ids: string[]; name: string }[]; pushes: string[]; complete: () => void; fail: () => void } }
}
const screens = process.env.GROUP_LEAD_SCREENSHOTS ?? '/tmp/collective-group-lead-screenshots';
const dialog = (page: Page) => page.getByRole('dialog', { name: 'New group chat', exact: true });
async function open(page: Page) { await page.getByRole('button', { name: 'New group chat', exact: true }).click(); }
async function pick(page: Page, ...names: string[]) {
  for (const name of names) await dialog(page).getByRole('checkbox', { name, exact: true }).check();
}
const start = (page: Page) => dialog(page).getByRole('button', { name: /Start group chat/ });

test.beforeAll(async () => { await mkdir(screens, { recursive: true }); });
test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto('/');
});

test('explicit choice, lead changes, deselection, repeat clicks, reset and mocked submit order', async ({ page }) => {
  await open(page);
  await pick(page, 'Researcher', 'Writer', 'Planner');
  await expect(start(page)).toBeDisabled();
  await expect(dialog(page).getByRole('radio', { checked: true })).toHaveCount(0);
  const writer = dialog(page).getByRole('radio', { name: 'Writer', exact: true });
  await writer.check(); await writer.click();
  await expect(writer).toBeChecked();
  await expect(dialog(page).getByText('Lead', { exact: true })).toHaveCount(2);
  await dialog(page).getByRole('checkbox', { name: 'Researcher', exact: true }).uncheck();
  await expect(writer).toBeChecked();
  await dialog(page).getByRole('checkbox', { name: 'Writer', exact: true }).uncheck();
  await pick(page, 'Writer', 'Researcher');
  await expect(start(page)).toBeDisabled();
  await expect(dialog(page).getByRole('radio', { checked: true })).toHaveCount(0);
  await dialog(page).getByRole('radio', { name: 'Researcher', exact: true }).check();
  await writer.check();
  await dialog(page).getByRole('textbox', { name: 'Group name (optional)' }).fill('Synthetic launch');
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await open(page);
  await expect(dialog(page).getByRole('checkbox', { checked: true })).toHaveCount(0);
  await expect(dialog(page).getByRole('textbox')).toHaveValue('');
  await pick(page, 'Researcher', 'Writer', 'Planner'); await writer.check();
  await dialog(page).getByRole('textbox').fill('Synthetic launch');
  await dialog(page).screenshot({ path: `${screens}/after-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  const memberBounds = await dialog(page).getByRole('checkbox', { name: 'Writer', exact: true }).boundingBox();
  const modalBounds = await dialog(page).boundingBox();
  expect(memberBounds!.x + memberBounds!.width).toBeLessThanOrEqual(modalBounds!.x + modalBounds!.width);
  await dialog(page).screenshot({ path: `${screens}/after-mobile-three.png` });
  await page.setViewportSize({ width: 1360, height: 900 });
  await start(page).dblclick();
  await expect(start(page)).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeVisible();
  expect(await page.evaluate(() => window.groupTest.calls)).toEqual([{ ids: ['synthetic-1', 'synthetic-0', 'synthetic-2'], name: 'Synthetic launch' }]);
  await page.evaluate(() => window.groupTest.complete());
  await expect(dialog(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.groupTest.pushes)).toEqual(['/c/synthetic-group']);
  await open(page);
  await expect(dialog(page).getByRole('radio')).toHaveCount(0);
  await expect(dialog(page).getByRole('textbox')).toHaveValue('');
});

test('six-member limit, small screens, dark mode, long names and routing indicators', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await open(page);
  await pick(page, 'Researcher', 'Writer', 'Planner', 'Analyst', 'Navigator', 'Reviewer');
  const seventh = dialog(page).getByRole('checkbox', { name: /Seventh bot/ });
  await expect(seventh).toBeDisabled();
  await dialog(page).getByRole('radio', { name: 'Reviewer', exact: true }).check();
  await expect(start(page)).toBeEnabled();
  await dialog(page).getByRole('checkbox', { name: 'Researcher', exact: true }).uncheck();
  await seventh.check();
  await dialog(page).getByRole('radio', { name: /Seventh bot/ }).check();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog(page).screenshot({ path: `${screens}/after-mobile-six.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await dialog(page).screenshot({ path: `${screens}/after-mobile-dark.png` });
  await page.keyboard.press('Escape');
  const header = page.getByRole('button', { name: 'Group members: Launch planning. Lead: Writer', exact: true });
  await expect(header).toBeVisible();
  await expect(header.getByText('Lead', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 640 });
  const geometry = await page.locator('header').evaluate(element => {
    const lead = element.querySelector('button[aria-label^="Group members"]')!.getBoundingClientRect();
    const controls = element.querySelector('a[href="/admin/spending"]')!.getBoundingClientRect();
    return { separated: lead.right <= controls.left || lead.bottom <= controls.top, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  expect(geometry.separated).toBe(true);
  expect(geometry.overflow).toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${screens}/after-group-header-mobile.png` });
  await header.click();
  const members = page.getByRole('list', { name: 'Group members' });
  await expect(members.getByText('Lead', { exact: true })).toHaveCount(1);
  await expect(members.getByRole('listitem').first()).toContainText('Writer');
  await expect(page.getByText('Messages without an @mention go to the lead bot. Use @mentions to address other members.')).toBeVisible();
  await page.screenshot({ path: `${screens}/after-group-members-mobile.png` });
});

test('keyboard controls, focus restoration and retry after a mocked error', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'New group chat', exact: true });
  await trigger.focus(); await page.keyboard.press('Enter');
  const researcher = dialog(page).getByRole('checkbox', { name: 'Researcher', exact: true });
  await expect(researcher).toBeFocused(); await page.keyboard.press('Space');
  await page.keyboard.press('Tab'); await page.keyboard.press('Space');
  const lead = dialog(page).getByRole('radio', { name: 'Researcher', exact: true });
  await lead.focus(); await page.keyboard.press('Space'); await page.keyboard.press('ArrowRight');
  await expect(dialog(page).getByRole('radio', { name: 'Writer', exact: true })).toBeChecked();
  await start(page).click(); await page.evaluate(() => window.groupTest.fail());
  await expect(start(page)).toBeEnabled();
  await expect(dialog(page).getByRole('radio', { name: 'Writer', exact: true })).toBeChecked();
  await start(page).click();
  expect(await page.evaluate(() => window.groupTest.calls)).toHaveLength(2);
  await page.evaluate(() => window.groupTest.complete());
  await expect(dialog(page)).toHaveCount(0);
  await open(page);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});

test('capture baseline dialog with identical synthetic members', async ({ page }) => {
  await page.goto('/?before'); await open(page);
  await dialog(page).getByRole('button', { name: /Researcher/ }).click();
  await dialog(page).getByRole('button', { name: /Writer/ }).click();
  await dialog(page).getByRole('button', { name: /Planner/ }).click();
  await dialog(page).screenshot({ path: `${screens}/before-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog(page).screenshot({ path: `${screens}/before-mobile.png` });
});
