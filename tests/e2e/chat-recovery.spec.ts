import { expect, test, type Page } from '@playwright/test';

const input = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const state = async (page: Page) => (await page.request.get('/fixture/state')).json();
const configure = async (page: Page, value: Record<string, unknown>) => { await page.request.post('/fixture/config', { data: value }); };
async function open(page: Page, mode = '') {
  await page.request.get('/fixture/reset' + mode);
  await page.goto('/' + mode);
  await expect(input(page)).toBeEnabled();
}
async function upload(page: Page, name = 'sample.txt') {
  await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('Synthetic attachment') });
  await expect(page.getByRole('button', { name: 'Remove ' + name, exact: true })).toBeVisible();
}
async function start(page: Page) {
  await input(page).fill('Start synthetic work');
  await input(page).press('Enter');
  await expect(page.getByText('Synthetic reply is still running.', { exact: true })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
});

test('failed Stop retains the live stream and retry verifies the saved run', async ({ page }) => {
  await open(page); await configure(page, { stop: 'fail' }); await start(page);
  await page.getByRole('button', { name: 'Stop generating', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('may still be running');
  expect((await state(page)).streams).toBe(1);
  await input(page).fill('Keep my next draft');
  await expect(page.getByRole('button', { name: 'Stop and send', exact: true })).toBeDisabled();
  await configure(page, { stop: 'success' });
  await page.getByRole('button', { name: 'Retry stop', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await expect(input(page)).toHaveValue('Keep my next draft');
  await expect.poll(async () => (await state(page)).streams).toBe(0);
  expect((await state(page)).stopRequests).toHaveLength(2);
});

test('Stop pending state prevents duplicate cancellation and keeps the stream attached', async ({ page }) => {
  await open(page); await configure(page, { stop: 'delayed' }); await start(page);
  await page.getByRole('button', { name: 'Stop generating', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stopping reply', exact: true })).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('Waiting for the server');
  expect((await state(page)).streams).toBe(1);
  expect((await state(page)).stopRequests).toHaveLength(1);
  await page.request.get('/fixture/release');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  await expect.poll(async () => (await state(page)).streams).toBe(0);
});

test('Stop-and-send keeps a failed follow-up draft and never submits it automatically', async ({ page }) => {
  await open(page); await configure(page, { stop: 'fail' }); await start(page);
  await input(page).fill('Replacement instructions'); await upload(page, 'follow-up.txt');
  await page.getByRole('button', { name: 'Stop and send', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Your draft has been kept');
  await expect(input(page)).toHaveValue('Replacement instructions');
  await expect(page.getByRole('button', { name: 'Remove follow-up.txt', exact: true })).toBeVisible();
  expect((await state(page)).requests).toHaveLength(1);
  await configure(page, { stop: 'success', send: 'accept' });
  await page.getByRole('button', { name: 'Retry stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  expect((await state(page)).requests).toHaveLength(1);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Synthetic reply accepted.', { exact: true })).toBeVisible();
  expect((await state(page)).requests[1].message.parts).toEqual([
    { type: 'file', filename: 'follow-up.txt', mediaType: 'text/plain', url: '/api/files/follow-up.txt' },
    { type: 'text', text: 'Replacement instructions' },
  ]);
});

test('successful Stop-and-send waits for server verification before the replacement request', async ({ page }) => {
  await open(page); await configure(page, { stop: 'delayed' }); await start(page);
  await input(page).fill('Replace this work');
  await page.getByRole('button', { name: 'Stop and send', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Waiting for the server');
  expect((await state(page)).requests).toHaveLength(1);
  await configure(page, { send: 'accept' }); await page.request.get('/fixture/release');
  await expect(page.getByText('Synthetic reply accepted.', { exact: true })).toBeVisible();
  expect((await state(page)).requests).toHaveLength(2);
});

test('zero cancellation counts cannot mark an active reply as stopped', async ({ page }) => {
  await open(page); await configure(page, { stop: 'noop' }); await start(page);
  await page.getByRole('button', { name: 'Stop generating', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('may still be running');
  expect((await state(page)).streams).toBe(1);
  await page.request.get('/fixture/finish');
  await page.getByRole('button', { name: 'Retry stop', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
});

test('positive counts for another run do not confirm an unadmitted first submission', async ({ page }) => {
  await open(page, '?empty'); await configure(page, { stop: 'unrelated', send: 'unadmitted' });
  await input(page).fill('Still admitting'); await input(page).press('Enter');
  await expect.poll(async () => (await state(page)).requests.length).toBe(1);
  await page.clock.install();
  await page.getByRole('button', { name: 'Stop generating', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Waiting for the server');
  await page.clock.fastForward(20_001);
  await expect(page.getByRole('alert')).toContainText('may still be running');
  expect((await state(page)).streams).toBe(1);
});

test('queued approval continuation can stop before its stream opens', async ({ page }) => {
  await open(page, '?approval'); await configure(page, { send: 'queued' });
  await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  await expect.poll(async () => (await state(page)).requests.length).toBe(1);
  await page.getByRole('button', { name: 'Stop generating', exact: true }).click();
  await expect(page.getByText('Stopped before it ran.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Stop can recover when the first submission is rejected while cancellation is pending', async ({ page }) => {
  await open(page, '?empty'); await configure(page, { send: 'reject', stop: 'delayed' });
  await upload(page); await input(page).fill('Keep the rejected first draft');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(async () => (await state(page)).requests.length).toBe(1);
  await page.getByRole('button', { name: 'Stop generating', exact: true }).click();
  await expect.poll(async () => (await state(page)).stopRequests.length).toBe(1);
  await page.request.get('/fixture/release?first');
  await expect(input(page)).toHaveValue('Keep the rejected first draft');
  await page.request.get('/fixture/release');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove sample.txt', exact: true })).toBeVisible();
});

test('Retry stop retains the rejected submission identity after the transcript becomes empty', async ({ page }) => {
  await open(page, '?empty'); await configure(page, { send: 'reject', stop: 'fail' });
  await input(page).fill('Recover this unsaved prompt'); await input(page).press('Enter');
  await expect.poll(async () => (await state(page)).requests.length).toBe(1);
  await page.getByRole('button', { name: 'Stop generating', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('may still be running');
  await page.request.get('/fixture/release');
  await expect(input(page)).toHaveValue('Recover this unsaved prompt');
  await page.getByRole('button', { name: 'Retry stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a failed status check keeps Stop unconfirmed until a later snapshot verifies completion', async ({ page }) => {
  await open(page); await configure(page, { snapshotError: true }); await start(page);
  await page.getByRole('button', { name: 'Stop generating', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('may still be running');
  expect((await state(page)).streams).toBe(1);
  await configure(page, { snapshotError: false, stop: 'noop' });
  await page.getByRole('button', { name: 'Retry stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a delayed regeneration cannot use its old saved prompt as admission evidence', async ({ page }) => {
  await open(page); await configure(page, { send: 'unadmitted', stop: 'noop' });
  await page.getByRole('button', { name: 'Regenerate', exact: true }).click();
  await expect.poll(async () => (await state(page)).requests.length).toBe(1);
  await page.getByRole('button', { name: 'Stop generating', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('may still be running');
  expect((await state(page)).streams).toBe(1);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toHaveCount(0);
});

test('a cancelled response with no saved assistant content still settles Stop', async ({ page }) => {
  await open(page); await configure(page, { send: 'start-only' });
  await input(page).fill('Stop before any text'); await input(page).press('Enter');
  await expect.poll(async () => (await state(page)).streams).toBe(1);
  await page.getByRole('button', { name: 'Stop generating', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect.poll(async () => (await state(page)).streams).toBe(0);
});

for (const empty of [false, true]) for (const text of ['', 'Read this attachment']) {
  test(`${empty ? 'first' : 'saved'} rejected ${text ? 'text and file' : 'file-only'} submission restores its complete retry`, async ({ page }) => {
    await open(page, empty ? '?empty' : ''); await configure(page, { send: 'reject' });
    await upload(page); if (text) await input(page).fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(async () => (await state(page)).requests.length).toBe(1);
    await expect(page.getByRole('button', { name: 'Remove sample.txt', exact: true })).toHaveCount(0);
    await page.request.get('/fixture/release');
    await expect(page.getByRole('button', { name: 'Remove sample.txt', exact: true })).toBeVisible();
    await expect(input(page)).toHaveValue(text);
    await configure(page, { send: 'accept' });
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByText('Synthetic reply accepted.', { exact: true })).toBeVisible();
    const { requests } = await state(page);
    expect(requests[1].message.parts).toEqual(requests[0].message.parts);
  });
}

test('first-message rejection preserves newer text and an upload already in flight', async ({ page }) => {
  await open(page, '?empty'); await configure(page, { send: 'reject' });
  await upload(page); await input(page).fill('Original draft');
  const originalComposer = await input(page).elementHandle();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(async () => (await state(page)).requests.length).toBe(1);
  await expect(input(page)).toBeEnabled(); await input(page).fill('Newer draft');
  let releaseUpload!: () => void;
  const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve; });
  await page.route('**/api/files', async route => {
    const response = await route.fetch(); await uploadGate; await route.fulfill({ response });
  });
  await upload(page, 'newer.txt');
  await page.request.get('/fixture/release');
  await expect(input(page)).toHaveValue('Original draft\n\nNewer draft');
  await expect(page.getByRole('button', { name: 'Remove sample.txt', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove newer.txt', exact: true })).toBeVisible();
  expect(await originalComposer!.evaluate(element => element === document.querySelector('textarea'))).toBe(true);
  releaseUpload();
  await configure(page, { send: 'accept' });
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Synthetic reply accepted.', { exact: true })).toBeVisible();
  expect((await state(page)).requests[1].message.parts.map((p: { filename?: string; text?: string }) => p.filename ?? p.text)).toEqual([
    'sample.txt', 'newer.txt', 'Original draft\n\nNewer draft',
  ]);
});
