import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';
test.skip(process.env.DOCKER_HERMES_BROWSER !== '1', 'Requires the explicit disposable browser broker/database fixture');
test.describe.configure({ mode: 'serial' });
const pool = new Pool({connectionString:process.env.DATABASE_URL});
const login=async(page:Page,name:string)=>{
  await page.goto('/login');await page.getByLabel('Local username or email').fill(`docker-hermes-${name}`);
  await page.getByLabel('Local password',{exact:true}).fill('Synthetic-Docker-Hermes!42');
  await page.getByRole('button',{name:'Sign in with local account'}).click();await page.waitForURL('/');
};
test.beforeAll(()=>{if(new URL(process.env.DATABASE_URL!).pathname!=='/collective_docker_hermes_test')throw new Error('Named disposable DB required');});
test.afterAll(async()=>pool.end());
test('admin enrollment is disabled by default, keyboard accessible, separate from readiness and denies ordinary users', async ({ page, browser }) => {
  await login(page, 'alice'); await page.goto('/admin/hermes');
  const enrollment = page.getByRole('region', { name: 'Personal Docker Hermes enrollment' });
  await expect(enrollment.getByText('Broker readiness: Ready', { exact: true })).toBeVisible();
  const allow = enrollment.getByRole('checkbox', { name: 'Allow personal Hermes for Docker Alice (local:docker-hermes-alice)', exact: true });
  await expect(allow).not.toBeChecked(); await allow.focus(); await page.keyboard.press('Space'); await expect(allow).toBeChecked();
  await expect(enrollment.getByRole('status')).toContainText('Permission saved');
  expect((await pool.query("SELECT count(*)::int n FROM bots WHERE owner_id=(SELECT id FROM users WHERE upn='local:docker-hermes-alice')")).rows[0].n).toBe(0);
  await page.reload(); await expect(allow).toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/docker-hermes-admin-mobile.png' });
  const context = await browser.newContext(); const ordinary = await context.newPage();
  try { await login(ordinary, 'charlie'); await ordinary.goto('/admin/hermes'); await expect(ordinary).toHaveURL('/'); await ordinary.goto('/settings?tab=connected-accounts'); await expect(ordinary.getByText('Personal Hermes', { exact: false })).toHaveCount(0); }
  finally { await context.close(); }
});

test('compact enable, reload-safe starter, readonly resources, new profile and owner privacy',async({page,browser})=>{
  await login(page,'alice');await page.goto('/settings?tab=connected-accounts');
  const personal=page.locator('details').filter({has:page.locator('summary').filter({hasText:'Personal Hermes'})}).first();
  await personal.locator('summary').first().click();
  await expect(personal.getByRole('status').first()).not.toContainText('Checking runtime status');
  const enable=personal.getByRole('button',{name:'Enable Hermes',exact:true});
  if(await enable.count()) { await expect(enable).toBeEnabled();await enable.click(); }
  await expect(personal.getByText('Runtime running',{exact:true})).toBeVisible({timeout:30000});
  const starter=personal.getByRole('link',{name:'Hermes',exact:true});await expect(starter).toBeVisible();
  const href=await starter.getAttribute('href');const id=href!.split('/').at(-1)!;
  await page.reload();await personal.locator('summary').first().click();await expect(starter).toBeVisible();
  expect((await pool.query("SELECT count(*)::int AS n FROM bots WHERE owner_id=(SELECT id FROM users WHERE upn='local:docker-hermes-alice')")).rows[0].n).toBe(1);
  await page.screenshot({path:'/tmp/docker-hermes-settings-desktop.png'});
  await starter.click();await page.waitForURL(`/bots/${id}`);await expect(page.getByText('Native Hermes skills · read only')).toBeVisible();
  await expect(page.getByText('Native example skill',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'New skill',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Memory',exact:true}).click();await page.getByText('MEMORY.md',{exact:true}).click();
  await expect(page.getByText('Native remembered fact',{exact:true})).toBeVisible();
  await page.screenshot({path:'/tmp/docker-hermes-native-memory.png'});
  await page.getByRole('link',{name:'Open home chat',exact:true}).click();
  const answers=page.getByRole('main').getByText('Fixture answer',{exact:true});const previous=(await pool.query('SELECT id FROM agent_runs WHERE bot_id=$1 ORDER BY created_at DESC LIMIT 1',[id])).rows[0]?.id;
  await page.getByLabel('Message',{exact:true}).fill('Browser native synthetic turn');await page.getByLabel('Message',{exact:true}).press('Enter');
  await expect.poll(async()=>{const row=(await pool.query('SELECT id,status FROM agent_runs WHERE bot_id=$1 ORDER BY created_at DESC LIMIT 1',[id])).rows[0];return row?.id!==previous&&row?.status==='succeeded';},{timeout:30000}).toBe(true);await expect(answers.last()).toBeVisible();
  await page.goto('/bots/new');await page.getByRole('button',{name:'configure',exact:true}).click();
  await page.getByPlaceholder('Name your bot',{exact:true}).fill('Browser Coder');await page.getByLabel('Bot engine',{exact:true}).click();await page.getByRole('option',{name:'Hermes',exact:true}).click();
  await page.getByLabel('Agent backend connection',{exact:true}).click();await page.getByRole('option',{name:'My Hermes runtime · new private profile',exact:true}).click();
  await page.getByRole('button',{name:'Create',exact:true}).click();await page.waitForURL(/\/bots\/[^/]+\/edit/);
  const rows=(await pool.query("SELECT id,visibility,coordinator_eligible FROM bots WHERE owner_id=(SELECT id FROM users WHERE upn='local:docker-hermes-alice')")).rows;
  expect(rows).toHaveLength(2);expect(rows.every(r=>r.visibility==='private'&&!r.coordinator_eligible)).toBe(true);
  await page.setViewportSize({width:390,height:844});await page.goto('/settings?tab=connected-accounts');await personal.locator('summary').first().click();
  await expect(personal.getByText('Runtime running',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'/tmp/docker-hermes-settings-mobile.png'});
  const context=await browser.newContext();const other=await context.newPage();
  try{await login(other,'bob');const denied=await other.request.get(`/api/bots/${id}/native`);expect([403,404]).toContain(denied.status());await other.goto('/admin/apps');await expect(other.getByText('Hermes · Personal Hermes',{exact:true})).toHaveCount(0);await expect(other.getByText('Browser Coder · Personal Hermes',{exact:true})).toHaveCount(0);await other.goto('/admin/pets');await expect(other.getByText('Browser Coder',{exact:true})).toHaveCount(0);}finally{await context.close();}
});

test('native creation stays compact and an existing profile keeps editable bot details',async({page})=>{
  await login(page,'alice');await page.goto('/bots/new');await page.getByRole('button',{name:'configure',exact:true}).click();
  await page.getByLabel('Bot engine',{exact:true}).click();await page.getByRole('option',{name:'Hermes',exact:true}).click();
  await page.getByLabel('Agent backend connection',{exact:true}).click();await page.getByRole('option',{name:'My Hermes runtime · new private profile',exact:true}).click();
  await expect(page.getByText('Creates a private native profile with the Moss companion.',{exact:false})).toBeVisible();
  await expect(page.getByRole('region',{name:'Pet avatar configuration'})).toHaveCount(0);
  await expect(page.getByPlaceholder('Name your bot',{exact:true})).toBeEnabled();
  const [bot]=(await pool.query("SELECT id FROM bots WHERE name='Browser Coder' AND owner_id=(SELECT id FROM users WHERE upn='local:docker-hermes-alice')")).rows;
  expect(bot).toBeDefined();await page.goto(`/bots/${bot.id}/edit`);
  // Confirm the client controls are interactive before typing into the server-rendered form.
  await page.getByRole('button', { name: 'Pet avatar settings for Browser Coder', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Pet avatar', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Pet avatar', exact: true })).toHaveCount(0);
  await page.getByPlaceholder('Name your bot',{exact:true}).fill('Browser Coder Updated');await page.getByRole('button',{name:'Update',exact:true}).click();
  await expect.poll(async()=>(await pool.query('SELECT name FROM bots WHERE id=$1',[bot.id])).rows[0].name).toBe('Browser Coder Updated');
  await page.goto('/settings?tab=connected-accounts');const personal=page.locator('details').filter({has:page.locator('summary').filter({hasText:'Personal Hermes'})}).first();await personal.locator('summary').first().click();
  await expect(personal.getByRole('link',{name:'Browser Coder Updated',exact:true})).toBeVisible();
  await page.screenshot({path:'/tmp/docker-hermes-settings-desktop.png'});await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'/tmp/docker-hermes-settings-mobile.png'});
});


test('revocation is reload-safe, retains bots and re-enrollment reuses private mappings', async ({ page }) => {
  await login(page, 'alice');
  const before = (await pool.query("SELECT id,app_id FROM bots WHERE owner_id=(SELECT id FROM users WHERE upn='local:docker-hermes-alice') ORDER BY id")).rows;
  await page.goto('/admin/hermes'); const enrollment = page.getByRole('region', { name: 'Personal Docker Hermes enrollment' });
  const allow = enrollment.getByRole('checkbox', { name: 'Allow personal Hermes for Docker Alice (local:docker-hermes-alice)', exact: true });
  await allow.click(); await expect(enrollment.getByRole('status')).toContainText('Permission revoked'); await expect(allow).not.toBeChecked();
  await expect.poll(async () => (await pool.query("SELECT cleanup FROM docker_hermes_enrollments WHERE user_id=(SELECT id FROM users WHERE upn='local:docker-hermes-alice')")).rows[0]?.cleanup, { timeout: 30000 }).toBe('stopped');
  await enrollment.getByRole('button', { name: 'Refresh enrollment and broker status', exact: true }).click();
  await expect(enrollment.getByText('Permission: Disabled · Runtime cleanup: Stopped — data retained', { exact: true })).toBeVisible();
  await page.reload(); await expect(allow).not.toBeChecked();
  expect([403, 404]).toContain((await page.request.get(`/api/bots/${before[0].id}/native`)).status());
  await allow.click(); await expect(enrollment.getByRole('status')).toContainText('Permission saved'); await expect(allow).toBeChecked();
  await page.goto('/settings?tab=connected-accounts');
  const personal = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'Personal Hermes' }) }).first();
  await personal.locator('summary').first().click(); await personal.getByRole('button', { name: 'Retry / start', exact: true }).click();
  await expect(personal.getByText('Runtime running', { exact: true })).toBeVisible({ timeout: 30000 });
  expect((await pool.query("SELECT id,app_id FROM bots WHERE owner_id=(SELECT id FROM users WHERE upn='local:docker-hermes-alice') ORDER BY id")).rows).toEqual(before);
});

test('starter setup explains blocked routes, clears incompatible models and opens runtime controls', async ({ page }) => {
  await login(page, 'alice');
  const [bot] = (await pool.query("SELECT id FROM bots WHERE owner_id=(SELECT id FROM users WHERE upn='local:docker-hermes-alice') AND name='Hermes'")).rows;
  const url = `/bots/${bot.id}/settings`, api = `**/api/bots/${bot.id}/native/settings`;
  await page.goto(url);
  await expect(page.getByLabel('Model ID', { exact: true })).toHaveValue('anthropic/claude-opus-4.6');
  await page.getByLabel('Model provider', { exact: true }).click();
  await page.getByRole('option', { name: 'ChatGPT / Codex subscription', exact: true }).click();
  await expect(page.getByLabel('Model ID', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Save profile settings', exact: true })).toBeDisabled();
  await page.getByLabel('Suggested Codex model', { exact: true }).click();
  await page.getByRole('option', { name: 'fixture-codex-model', exact: true }).click();
  await expect(page.getByLabel('Model ID', { exact: true })).toHaveValue('fixture-codex-model');
  await expect(page.getByRole('button', { name: 'Save profile settings', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Sign in with OpenAI', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page.getByLabel('Model ID', { exact: true })).toHaveValue('anthropic/claude-opus-4.6');

  // Only mutate response fixtures: no sign-in, profile save, or inference request.
  let scenario: 'old-bridge' | 'custom-route' | 'offline' = 'old-bridge';
  let mutations = 0, unsupportedCodexRequests = 0;
  await page.route(`**/api/bots/${bot.id}/native/codex`, async route => {
    if (scenario !== 'offline') { unsupportedCodexRequests++; await route.fulfill({ status: 404, json: { error: 'Synthetic older bridge: subscription command unavailable.' } }); }
    else await route.continue();
  });
  await page.route(api, async route => {
    if (route.request().method() !== 'GET') { mutations++; await route.abort(); return; }
    const response = await route.fetch(), data = await response.json();
    data.settings.provider = 'openai-codex'; data.settings.model = 'fixture-codex-model';
    if (scenario === 'old-bridge') delete data.settings.editableProviders['openai-codex'];
    if (scenario === 'custom-route') {
      data.settings.editableProviders['openai-codex'] = false;
      data.settings.providerBlockers = { 'openai-codex': 'custom_endpoint' };
    }
    if (scenario === 'offline') data.runtime.network = 'none';
    await route.fulfill({ response, json: data });
  });
  await page.reload();
  await expect(page.locator('#hermes-save-blocker')).toContainText('update the Hermes bridge');
  await expect(page.getByRole('button', { name: 'Sign in with OpenAI', exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 1360, height: 1700 });
  await page.screenshot({ path: '/tmp/hermes-pr22-missing-capability.png', fullPage: true });
  scenario = 'custom-route'; await page.reload();
  await expect(page.locator('#hermes-save-blocker')).toContainText('custom provider endpoint');
  await page.screenshot({ path: '/tmp/hermes-pr22-protected-config.png', fullPage: true });
  await page.setViewportSize({ width: 1360, height: 900 });
  expect(unsupportedCodexRequests).toBe(0);
  scenario = 'offline'; await page.reload();
  await expect(page.getByText('Offline · access blocked', { exact: true })).toBeVisible();
  await expect(page.getByText('Not tested', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with OpenAI', exact: true })).toBeDisabled();
  await expect(page.locator('#codex-start-blocker')).toContainText('runtime is offline');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 2300 });
  await page.screenshot({ path: '/tmp/hermes-pr22-offline-mobile.png', fullPage: true });
  expect(mutations).toBe(0);
  await page.getByRole('link', { name: 'Manage your runtime', exact: true }).click();
  const personal = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'Personal Hermes' }) }).first();
  await expect(personal).toHaveAttribute('open', '');
  await expect(personal.getByText('Runtime running', { exact: true })).toBeVisible();
});

test('profile onboarding persists, tests explicitly, rejects stale saves and clears keys', async ({ page, browser }) => {
  await login(page, 'alice');
  const [bot] = (await pool.query("SELECT id FROM bots WHERE owner_id=(SELECT id FROM users WHERE upn='local:docker-hermes-alice') AND name='Hermes'")).rows;
  const url = `/bots/${bot.id}/settings`;
  await page.goto(`/bots/${bot.id}`); await page.getByRole('link', { name: 'Hermes settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your native profile' })).toBeVisible();
  await expect(page.getByLabel('Model ID', { exact: true })).toBeVisible();
  await page.getByLabel('Model provider', { exact: true }).click(); await page.getByRole('option', { name: 'OpenAI API', exact: true }).click();
  await page.getByLabel('Model ID', { exact: true }).fill('denied-model');
  await page.getByLabel('API key', { exact: true }).click(); await page.getByRole('option', { name: /^(Add|Replace) API key$/ }).click();
  const secret = 'sk-browser-synthetic-not-real'; await page.getByLabel('New API key', { exact: true }).fill(secret);
  await page.getByText('Advanced profile settings', { exact: true }).click();
  await page.getByLabel('Maximum agent turns', { exact: true }).fill('12');
  await page.getByLabel('Reasoning effort', { exact: true }).click(); await page.getByRole('option', { name: 'low', exact: true }).click();
  await page.getByRole('button', { name: 'Save profile settings', exact: true }).click();
  await expect(page.getByText('Saved in this native profile.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('New API key', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Test saved connection', exact: true })).toBeDisabled();
  await page.getByLabel('I understand this test may incur inference charges.').check();
  await page.getByRole('button', { name: 'Test saved connection', exact: true }).click();
  await expect(page.getByText('The provider rejected the API key.', { exact: false })).toBeVisible();
  await page.getByLabel('Model ID', { exact: true }).fill('fixture-model');
  await page.getByRole('button', { name: 'Save profile settings', exact: true }).click();
  await expect(page.getByText('Not tested', { exact: true })).toBeVisible();
  await page.getByLabel('I understand this test may incur inference charges.').check();
  await page.getByRole('button', { name: 'Test saved connection', exact: true }).click();
  await expect(page.getByText('Connection verified for this saved model and API key.', { exact: false })).toBeVisible();
  const response = await page.request.get(`/api/bots/${bot.id}/native/settings`); expect(await response.text()).not.toContain(secret);
  await page.reload(); await expect(page.getByLabel('Model ID', { exact: true })).toHaveValue('fixture-model');
  await expect(page.getByText('Verified', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1360, height: 1400 });
  await page.screenshot({ path: '/tmp/hermes-profile-settings-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 1360, height: 900 });

  // Two tabs: the second must reload rather than overwrite a newer native revision.
  const other = await page.context().newPage(); await other.goto(url); await expect(other.getByLabel('Model ID', { exact: true })).toHaveValue('fixture-model');
  await page.getByLabel('Model ID', { exact: true }).fill('fixture-newer'); await page.getByRole('button', { name: 'Save profile settings', exact: true }).click();
  await expect(page.getByText('Saved in this native profile.', { exact: false })).toBeVisible();
  await other.getByLabel('Model ID', { exact: true }).fill('fixture-stale'); await other.getByRole('button', { name: 'Save profile settings', exact: true }).click();
  await expect(other.getByRole('alert').filter({ hasText: 'changed' })).toContainText('changed');
  await other.getByRole('button', { name: 'Reload saved settings', exact: true }).click(); await expect(other.getByLabel('Model ID', { exact: true })).toHaveValue('fixture-newer'); await other.close();

  // Leaving an unsubmitted setup never persists a key or model.
  await page.getByLabel('Model ID', { exact: true }).fill('discard-this-model');
  await page.getByLabel('API key', { exact: true }).click(); await page.getByRole('option', { name: 'Replace API key', exact: true }).click();
  await page.getByLabel('New API key', { exact: true }).fill('sk-discard-this-fixture'); await page.getByRole('link', { name: 'Done for now', exact: true }).click();
  await page.goto(url); await expect(page.getByLabel('Model ID', { exact: true })).toHaveValue('fixture-newer'); await expect(page.getByLabel('New API key', { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/hermes-profile-settings-mobile.png', fullPage: true });
  await page.getByRole('heading', { name: 'Test the connection', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/hermes-profile-settings-mobile-test.png', fullPage: true });
  await page.getByLabel('API key', { exact: true }).click(); await page.getByRole('option', { name: 'Clear profile key and disable selected provider', exact: true }).click();
  await page.getByRole('button', { name: 'Save profile settings', exact: true }).click(); await expect(page.getByText('Setup needed', { exact: true })).toBeVisible();

  const context = await browser.newContext(); const denied = await context.newPage();
  try { await login(denied, 'bob'); expect([403, 404]).toContain((await denied.request.get(`/api/bots/${bot.id}/native/settings`)).status()); }
  finally { await context.close(); }
});

test('interrupted save reloads committed state without resending credentials or testing', async ({ page }) => {
  await login(page, 'alice');
  const [bot] = (await pool.query("SELECT id FROM bots WHERE owner_id=(SELECT id FROM users WHERE upn='local:docker-hermes-alice') AND name='Hermes'")).rows;
  const url = `/bots/${bot.id}/settings`, api = `**/api/bots/${bot.id}/native/settings`;
  await page.goto(url); await expect(page.getByLabel('Model ID', { exact: true })).toBeVisible();
  await page.getByLabel('Model ID', { exact: true }).fill('interrupted-fixture-model');
  let commit!: () => void, release!: () => void, saves = 0, tests = 0;
  const committed = new Promise<void>(resolve => { commit = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  await page.route(api, async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const operation = route.request().postDataJSON().operation;
    if (operation === 'test') tests++;
    if (operation !== 'save') { await route.continue(); return; }
    saves++;
    const response = await route.fetch(); expect(response.status()).toBe(200); commit();
    await resume; await route.fulfill({ response }).catch(() => {});
  });
  await page.getByRole('button', { name: 'Save profile settings', exact: true }).click(); await committed;
  const reload = page.reload(); release(); await reload;
  await expect(page.getByLabel('Model ID', { exact: true })).toHaveValue('interrupted-fixture-model');
  await page.getByRole('button', { name: 'Reload saved settings', exact: true }).click();
  await expect(page.getByLabel('Model ID', { exact: true })).toHaveValue('interrupted-fixture-model');
  expect(saves).toBe(1); expect(tests).toBe(0);
  await page.unroute(api);
});

test('subscription device login resumes after reload, cancels safely, reconnects and disconnects', async ({ page, browser }) => {
  await login(page, 'alice');
  const [bot] = (await pool.query("SELECT id FROM bots WHERE owner_id=(SELECT id FROM users WHERE upn='local:docker-hermes-alice') AND name='Hermes'")).rows;
  await page.goto(`/bots/${bot.id}/settings`);
  await page.getByLabel('Model provider', { exact: true }).click();
  await page.getByRole('option', { name: 'ChatGPT / Codex subscription', exact: true }).click();
  await page.getByLabel('Model ID', { exact: true }).fill('fixture-pending-model');
  await expect(page.getByLabel('New API key', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save profile settings', exact: true }).click();
  await expect(page.getByText('Saved in this native profile.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in with OpenAI', exact: true }).click();
  await expect(page.getByLabel('OpenAI verification code')).toHaveText('DEMO-CODE');
  await expect(page.getByRole('link', { name: 'Open OpenAI verification' })).toHaveAttribute('href', 'https://auth.openai.com/codex/device');
  await expect(page.getByLabel('Model ID', { exact: true })).toBeDisabled();
  await page.reload(); await expect(page.getByLabel('OpenAI verification code')).toHaveText('DEMO-CODE');
  await page.evaluate(() => localStorage.setItem('theme', 'dark')); await page.reload();
  await page.setViewportSize({ width: 1360, height: 1850 });
  await expect(page.getByLabel('OpenAI verification code')).toBeVisible();
  await page.screenshot({ path: '/tmp/hermes-codex-device-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/hermes-codex-device-mobile.png' });
  await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
  await expect(page.getByText('Sign-in cancelled. This profile is disconnected.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Model ID', { exact: true })).toBeEnabled();
  await page.getByLabel('Model ID', { exact: true }).fill('fixture-codex-model');
  await page.getByRole('button', { name: 'Save profile settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in with OpenAI', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Sign in with OpenAI', exact: true }).click();
  await expect(page.getByText('Signed in to ChatGPT / Codex for this profile. Model access has not been tested.', { exact: true })).toBeVisible({ timeout: 20000 });
  await page.reload(); await expect(page.getByRole('button', { name: 'Reconnect with OpenAI', exact: true })).toBeEnabled();
  await page.screenshot({ path: '/tmp/hermes-codex-connected-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Reconnect with OpenAI', exact: true }).click();
  await expect(page.getByLabel('OpenAI verification code')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
  await expect(page.getByText('Sign-in cancelled. This profile is disconnected.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect this profile', exact: true }).click();
  await expect(page.getByText('No subscription sign-in stored for this profile.', { exact: true })).toBeVisible();
  const context = await browser.newContext({ ignoreHTTPSErrors: true }); const other = await context.newPage();
  try { await login(other, 'bob'); expect([403, 404]).toContain((await other.request.get(`/api/bots/${bot.id}/native/codex`)).status()); }
  finally { await context.close(); }
});


test('lost subscription mutation response reloads the native revision before retry', async ({ page }) => {
  await login(page, 'alice');
  const [bot] = (await pool.query("SELECT id FROM bots WHERE owner_id=(SELECT id FROM users WHERE upn='local:docker-hermes-alice') AND name='Hermes'")).rows;
  await page.goto(`/bots/${bot.id}/settings`);
  await page.getByRole('button', { name: 'Sign in with OpenAI', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reconnect with OpenAI', exact: true })).toBeEnabled({ timeout: 20000 });
  let dropped = false;
  await page.route(`**/api/bots/${bot.id}/native/codex`, async route => {
    if (!dropped && route.request().method() === 'POST' && route.request().postDataJSON().action === 'disconnect') {
      dropped = true; await route.fetch(); await route.abort('failed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Disconnect this profile', exact: true }).click();
  await expect(page.getByRole('region', { name: 'ChatGPT / Codex subscription', exact: true }).getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Reload sign-in status', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in with OpenAI', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Sign in with OpenAI', exact: true }).click();
  await expect(page.getByLabel('OpenAI verification code')).toHaveText('DEMO-CODE');
  await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
  await expect(page.getByText('Sign-in cancelled. This profile is disconnected.', { exact: true })).toBeVisible();
});

test('changing providers clears unsaved credentials and restores the saved model when switching back', async ({ page }) => {
  await login(page, 'alice');
  const [bot] = (await pool.query("SELECT id FROM bots WHERE owner_id=(SELECT id FROM users WHERE upn='local:docker-hermes-alice') AND name='Hermes'")).rows;
  await page.goto(`/bots/${bot.id}/settings`);
  const model = page.getByLabel('Model ID', { exact: true });
  await expect(model).toHaveValue('fixture-codex-model');
  const select = async (name: string) => {
    await page.getByLabel('Model provider', { exact: true }).click();
    await page.getByRole('option', { name, exact: true }).click();
  };
  await select('Anthropic'); await expect(model).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Save profile settings', exact: true })).toBeDisabled();
  await model.fill('unsaved-anthropic');
  await page.getByLabel('API key', { exact: true }).click(); await page.getByRole('option', { name: 'Add API key', exact: true }).click();
  await page.getByLabel('New API key', { exact: true }).fill('sk-unsaved-provider-fixture');
  await select('ChatGPT / Codex subscription'); await expect(model).toHaveValue('fixture-codex-model');
  await select('Anthropic'); await expect(model).toHaveValue('');
  await expect(page.getByLabel('New API key', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(model).toHaveValue('fixture-codex-model');
  await select('Anthropic'); await model.fill('fixture-anthropic-model');
  await page.screenshot({ path: '/tmp/hermes-pr22-provider-switch.png', fullPage: true });
  await page.getByRole('button', { name: 'Save profile settings', exact: true }).click();
  await expect(page.getByText('Saved in this native profile.', { exact: false })).toBeVisible();
  await page.reload(); await expect(model).toHaveValue('fixture-anthropic-model');
  const saved = await (await page.request.get(`/api/bots/${bot.id}/native/settings`)).json();
  expect(saved.settings.provider).toBe('anthropic');
  expect(JSON.stringify(saved)).not.toContain('sk-unsaved-provider-fixture');
});
