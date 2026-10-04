import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';
test.skip(process.env.DOCKER_HERMES_BROWSER !== '1', 'Requires the explicit disposable browser broker/database fixture');
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
  await expect(personal.getByText('Runtime ready',{exact:true})).toBeVisible({timeout:30000});
  const starter=personal.getByRole('link',{name:'Hermes',exact:true});await expect(starter).toBeVisible();
  const href=await starter.getAttribute('href');const id=href!.split('/').at(-1)!;
  await page.reload();await personal.locator('summary').first().click();await expect(starter).toBeVisible();
  expect((await pool.query("SELECT count(*)::int AS n FROM bots WHERE owner_id=(SELECT id FROM users WHERE upn='local:docker-hermes-alice')")).rows[0].n).toBe(1);
  await page.screenshot({path:'/tmp/docker-hermes-settings-desktop.png'});
  await starter.click();await expect(page.getByText('Native Hermes skills · read only')).toBeVisible();
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
  await expect(personal.getByText('Runtime ready',{exact:true})).toBeVisible();
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
  await allow.uncheck(); await expect(enrollment.getByRole('status')).toContainText('Permission revoked');
  await expect.poll(async () => (await pool.query("SELECT cleanup FROM docker_hermes_enrollments WHERE user_id=(SELECT id FROM users WHERE upn='local:docker-hermes-alice')")).rows[0]?.cleanup, { timeout: 30000 }).toBe('stopped');
  await enrollment.getByRole('button', { name: 'Refresh enrollment and broker status', exact: true }).click();
  await expect(enrollment.getByText('Permission: Disabled · Runtime cleanup: Stopped — data retained', { exact: true })).toBeVisible();
  await page.reload(); await expect(allow).not.toBeChecked();
  expect([403, 404]).toContain((await page.request.get(`/api/bots/${before[0].id}/native`)).status());
  await allow.check(); await expect(enrollment.getByRole('status')).toContainText('Permission saved');
  await page.goto('/settings?tab=connected-accounts');
  const personal = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'Personal Hermes' }) }).first();
  await personal.locator('summary').first().click(); await personal.getByRole('button', { name: 'Retry / start', exact: true }).click();
  await expect(personal.getByText('Runtime ready', { exact: true })).toBeVisible({ timeout: 30000 });
  expect((await pool.query("SELECT id,app_id FROM bots WHERE owner_id=(SELECT id FROM users WHERE upn='local:docker-hermes-alice') ORDER BY id")).rows).toEqual(before);
});
