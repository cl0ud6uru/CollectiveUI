import { expect, test } from '@playwright/test';
test.beforeEach(async ({ request }) => { await request.post('/__control', { data: { reset: true } }); });
const widget = (page: import('@playwright/test').Page) => page.frameLocator('iframe[title="Synthetic table widget"]').frameLocator('iframe[title="Widget content"]');

test('Ticket Tracker-style draft renders and previews locally without creating tickets or calling tools', async ({ page, request }) => {
  await request.post('/__control', { data: { reset: true, ticket: true } });
  await page.goto('/');
  const draft = page.frameLocator('iframe[title="Synthetic ticket draft"]').frameLocator('iframe[title="Widget content"]');
  await expect(draft.getByText('Draft ready', { exact: true })).toBeVisible();
  await expect(draft.getByLabel('Summary', { exact: true })).toHaveValue('Synthetic printer test');
  await expect(draft.getByLabel('Description')).toHaveValue('Invented test data only.');
  await expect(draft.getByLabel('Reporter')).toHaveValue('Fixture User (fixture@example.invalid)');
  await expect(draft.getByText('SYNTHETIC_TICKET_COMPONENT_ONLY')).toBeVisible();
  await expect(page.getByText('SYNTHETIC_TICKET_COMPONENT_ONLY')).toHaveCount(0);
  await draft.getByLabel('Summary', { exact: true }).fill('Synthetic monitor test');
  await draft.getByLabel('Description').fill('Synthetic multiline details\nNo real issue.');
  await draft.getByRole('combobox', { name: 'Work location', exact: true }).selectOption('Test remote');
  await draft.getByRole('combobox', { name: 'Scope', exact: true }).selectOption('Test team');
  await draft.getByLabel('Include synthetic attachment').check();
  await draft.getByRole('button', { name: 'Preview changes' }).click();
  await expect(draft.getByText('Synthetic monitor test · Test remote · Test team · attachment included')).toBeVisible();
  await expect(draft.getByRole('button', { name: 'Create ticket (disabled in fixture)' })).toBeDisabled();
  await expect(draft.getByText('Preview updated; no ticket submitted')).toBeVisible();
  expect(await (await request.get('/__stats')).json()).toEqual({ calls: [], actions: [] });
});

test('official AppBridge renders forms, tables and buttons inside the isolated network-denied sandbox', async ({ page, request }) => {
  await page.goto('/'); const app = widget(page);
  await expect(app.getByText('Ready', { exact: true })).toBeVisible();
  await expect(app.getByRole('cell', { name: 'Alpha', exact: true })).toBeVisible();
  await expect(app.getByText('SYNTHETIC_BROWSER_COMPONENT_ONLY')).toBeVisible();
  await expect(page.getByText('SYNTHETIC_BROWSER_COMPONENT_ONLY')).toHaveCount(0);
  await expect(app.getByText('Isolated', { exact: true })).toBeVisible();
  await app.getByLabel('Filter').fill('Beta'); await app.getByRole('button', { name: 'Apply filter' }).click();
  await expect(app.getByText('Filtered', { exact: true })).toBeVisible();
  await expect(app.getByRole('cell', { name: 'Alpha', exact: true })).toHaveCount(0); await expect(app.getByRole('cell', { name: 'Beta' })).toBeVisible();
  await app.getByRole('button', { name: 'Check network' }).click(); await expect(app.getByText('Network blocked')).toBeVisible();
  await app.getByRole('button', { name: 'Fail tool' }).click(); await expect(app.getByText('Tool failed')).toBeVisible();
  expect((await (await request.get('/__stats')).json()).calls).toEqual(['refresh', 'fail']);
  await page.screenshot({ path: '/tmp/collectiveui-mcp-apps-standard.png', fullPage: true });
});

test('host-owned approvals allow once or deny, and pending requests survive page reload without automatic execution', async ({ page, request }) => {
  await page.goto('/'); const app = widget(page); await expect(app.getByText('Ready', { exact: true })).toBeVisible();
  await app.getByRole('button', { name: 'Save row' }).click();
  await expect(page.getByText('Approval required: save')).toBeVisible();
  expect((await (await request.get('/__stats')).json()).calls).toEqual([]);
  await page.getByRole('button', { name: 'Deny', exact: true }).click(); await expect(app.getByText('Denied', { exact: true })).toBeVisible();
  await app.getByRole('button', { name: 'Save row' }).click(); await page.getByRole('button', { name: 'Allow once' }).click();
  await expect(app.getByText('Saved', { exact: true })).toBeVisible();
  await app.getByRole('button', { name: 'Save row' }).click(); await expect(page.getByText('Approval required: save')).toBeVisible();
  await page.reload(); await expect(widget(page).getByText('Ready', { exact: true })).toBeVisible();
  await expect(page.getByText('Approval required: save')).toBeVisible();
  expect((await (await request.get('/__stats')).json()).calls).toEqual(['save']);
  await page.getByRole('button', { name: 'Allow once' }).click();
  expect((await (await request.get('/__stats')).json()).calls).toEqual(['save', 'save']);
  await page.getByRole('button', { name: 'Reload widget' }).click(); await expect(widget(page).getByText('Ready', { exact: true })).toBeVisible();
  expect((await (await request.get('/__stats')).json()).calls).toEqual(['save', 'save']);
});

test('legacy OpenAI globals and explicitly supported callTool work, while unavailable capabilities fail clearly', async ({ page, request }) => {
  await request.post('/__control', { data: { reset: true, compatibility: true } });
  await page.goto('/'); const app = widget(page); await expect(app.getByRole('cell', { name: 'Alpha' })).toBeVisible();
  await expect(app.getByText('SYNTHETIC_BROWSER_COMPONENT_ONLY')).toBeVisible();
  await app.getByLabel('Filter').fill('Beta'); await app.getByRole('button', { name: 'Apply filter' }).click(); await expect(app.getByText('Filtered', { exact: true })).toBeVisible();
  await app.getByRole('button', { name: 'Save row' }).click(); await page.getByRole('button', { name: 'Allow once' }).click(); await expect(app.getByText('Saved', { exact: true })).toBeVisible();
  await app.getByRole('button', { name: 'Fail tool' }).click(); await expect(app.getByText('Unsupported', { exact: true })).toBeVisible();
});

test('source-bound messages cannot spoof calls; revocation removes the iframe and resource failures keep a fallback', async ({ page, request }) => {
  await page.clock.install(); await page.goto('/'); await expect(widget(page).getByText('Ready', { exact: true })).toBeVisible();
  await page.evaluate(() => window.postMessage({ jsonrpc: '2.0', id: 'spoof', method: 'tools/call', params: { name: 'save', arguments: {} } }, '*'));
  expect((await (await request.get('/__stats')).json()).actions).toEqual([]);
  await request.post('/__control', { data: { revoke: true } }); await page.clock.fastForward(21000);
  await expect(page.getByRole('alert')).toContainText('permissions revoked'); await expect(page.locator('iframe')).toHaveCount(0);
  await request.post('/__control', { data: { reset: true, loadError: true } }); await page.reload();
  await expect(page.getByRole('alert')).toContainText('resource is unavailable'); await expect(page.getByRole('alert')).toContainText('saved text result');
});
