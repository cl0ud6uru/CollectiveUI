import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';
test.skip(process.env.DOCKER_HERMES_NETWORK_BROWSER!=='1','Explicit disposable network fixture required');
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const login=async(page:Page,name:string)=>{await page.goto('/login');await page.getByLabel('Local username or email').fill(`docker-hermes-${name}`);await page.getByLabel('Local password',{exact:true}).fill('Synthetic-Docker-Hermes!42');await page.getByRole('button',{name:'Sign in with local account'}).click();await page.waitForURL('/');};
test.beforeAll(()=>{if(new URL(process.env.DATABASE_URL!).pathname!=='/collective_docker_hermes_test')throw new Error('Named disposable DB required');});
test.afterAll(async()=>pool.end());
test('Admin network toggle preserves offline default, requires restart approval, retains bindings, and separates TLS from paid model access',async({page,browser})=>{
 const auditCount=Number((await pool.query("SELECT count(*) FROM audit_log WHERE action='hermes.docker.network.request' AND target=(SELECT id FROM users WHERE upn='local:docker-hermes-alice')")).rows[0].count);
 await login(page,'alice');await page.goto('/admin/hermes');
 const region=page.getByRole('region',{name:'Personal Docker Hermes enrollment'}),row=region.getByRole('row').filter({hasText:'local:docker-hermes-alice'});
 await expect(row.getByText('Offline',{exact:true})).toBeVisible();
 const allow=row.getByRole('checkbox',{name:'Allow personal Hermes for Docker Alice (local:docker-hermes-alice)',exact:true});if(!await allow.isChecked())await allow.click();await expect(allow).toBeChecked();
 const internet=row.getByRole('checkbox',{name:'Internet access for Docker Alice',exact:true});await expect(internet).not.toBeChecked();await expect(internet).toBeEnabled();
 await page.goto('/settings?tab=connected-accounts&section=personal-hermes');const personal=page.locator('details').filter({has:page.locator('summary').filter({hasText:'Personal Hermes'})}).first();
 await expect(personal.getByRole('status').first()).not.toContainText('Checking runtime status');
 const enable=personal.getByRole('button',{name:'Enable Hermes',exact:true});if(await enable.count())await enable.click();await expect(personal.getByText('Runtime running',{exact:true})).toBeVisible({timeout:30000});
 const [bot]=(await pool.query("SELECT id,app_id FROM bots WHERE owner_id=(SELECT id FROM users WHERE upn='local:docker-hermes-alice') AND name='Hermes'")).rows;expect(bot).toBeDefined();
 await page.goto(`/bots/${bot.id}/settings`);await page.getByLabel('Model provider',{exact:true}).click();await page.getByRole('option',{name:'OpenAI API',exact:true}).click();await page.getByLabel('Model ID',{exact:true}).fill(`fixture-network-model-${Date.now()}`);await page.getByRole('button',{name:'Save profile settings',exact:true}).click();
 await expect(page.getByRole('button',{name:'Check provider connectivity',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Check provider connectivity',exact:true}).click();
 await expect(page.getByText('Internet access is off. An administrator can turn it on in Admin → Managed Hermes.',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:'Test saved connection',exact:true})).toBeDisabled();
 const before=(await pool.query('SELECT id,app_id FROM bots WHERE owner_id=(SELECT id FROM users WHERE upn=\'local:docker-hermes-alice\') ORDER BY id')).rows;
 await page.goto('/admin/hermes');await expect(internet).toBeEnabled();await internet.focus();await page.keyboard.press('Space');
 const dialog=page.getByRole('dialog',{name:'Change Internet access for Docker Alice',exact:true});await expect(dialog).toBeVisible();await expect(dialog.getByText('Standard Internet uses a dedicated Docker bridge with no published ports.',{exact:false})).toBeVisible();
 await page.screenshot({path:'/tmp/cui-task7-network-consent.png',fullPage:true});
 const apply=dialog.getByRole('button',{name:'Apply network policy',exact:true});await expect(apply).toBeDisabled();await dialog.getByRole('checkbox',{name:'I approve this policy and any required runtime restart.',exact:true}).check();await apply.click();
 await expect(dialog).toHaveCount(0);await expect(internet).toBeChecked();await expect(row.getByText('Standard Internet · running',{exact:true})).toBeVisible({timeout:30000});
 await page.reload();await expect(internet).toBeChecked();expect((await pool.query('SELECT id,app_id FROM bots WHERE owner_id=(SELECT id FROM users WHERE upn=\'local:docker-hermes-alice\') ORDER BY id')).rows).toEqual(before);
 await page.screenshot({path:'/tmp/cui-task7-network-admin-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'/tmp/cui-task7-network-admin-mobile.png',fullPage:true});
 await page.goto(`/bots/${bot.id}/settings`);await page.getByRole('button',{name:'Check provider connectivity',exact:true}).click();await expect(page.getByText('Provider TLS connection reached. Sign-in and model access still need verification.',{exact:false})).toBeVisible();await expect(page.getByText('API key saved',{exact:true})).toHaveCount(0);await expect(page.getByText('Not tested',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Test saved connection',exact:true})).toBeDisabled();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'/tmp/cui-task7-network-profile-mobile.png',fullPage:true});
 const ordinary=await browser.newContext(),other=await browser.newContext();try{
  const p=await ordinary.newPage();await login(p,'charlie');expect((await p.request.get('/api/admin/hermes/network')).status()).toBe(403);
  const b=await other.newPage();await login(b,'bob');expect([403,404]).toContain((await b.request.get(`/api/bots/${bot.id}/native/settings`)).status());
 }finally{await ordinary.close();await other.close();}
 await page.goto('/admin/hermes');await internet.click();await dialog.getByRole('checkbox',{name:'I approve this policy and any required runtime restart.',exact:true}).check();await dialog.getByRole('button',{name:'Apply network policy',exact:true}).click();await expect(row.getByText('Offline · running',{exact:true})).toBeVisible({timeout:30000});
 const audits=(await pool.query("SELECT details FROM audit_log WHERE action='hermes.docker.network.request' AND target=(SELECT id FROM users WHERE upn='local:docker-hermes-alice') ORDER BY created_at")).rows;expect(audits).toHaveLength(auditCount+2);expect(audits.slice(-2).every(a=>a.details.status==='accepted'&&a.details.confirmedRestart)).toBe(true);
});
