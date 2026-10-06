/** Real UI saves against an explicitly disposable local-account installation. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { eq, inArray } from 'drizzle-orm';
import { db, pool } from '../../src/db/index.ts';
import { aiApps, botUserAccess, bots, groupMembers, groups, localAuthBootstrap, users } from '../../src/db/schema.ts';
import { createLocalUser } from '../../src/lib/auth/local.ts';
import { newId } from '../../src/lib/ids.ts';

const url = process.env.BASE_URL ?? 'https://localhost:3111';
if (new URL(process.env.DATABASE_URL ?? '').pathname !== '/collective_direct_permissions_test' || url !== 'https://localhost:3111')
  throw new Error('Dedicated disposable permissions database and https localhost:3111 required');
const suffix = newId().toLowerCase(), username = `permissions-${suffix}`, password = 'Synthetic-browser-phrase!42';
const name = `Direct group ${suffix}`, botName = `Direct bot ${suffix}`;
const userIds = []; let appId, botId, groupId, browser, page;
try {
  const admin = await createLocalUser({ username, name: 'Permissions Admin', password }, 'bootstrap'); userIds.push(admin.id);
  const [member] = await db.insert(users).values({ upn: `${suffix}@fixture.invalid`, name: 'Direct Recipient', authSource: 'ldap', email: `${suffix}@fixture.invalid` }).returning(); userIds.push(member.id);
  const [app] = await db.insert(aiApps).values({ name: `UI model ${suffix}`, provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:4010/v1', model: 'fixture', supportsTools: true }).returning(); appId = app.id;
  const [bot] = await db.insert(bots).values({ ownerId: admin.id, appId, name: botName, visibility: 'private' }).returning(); botId = bot.id;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1360, height: 1000 } });
  page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(30000);
  await page.goto(`${url}/login`);
  await page.getByLabel('Local username or email').fill(username);
  await page.getByLabel('Local password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in with local account', exact: true }).click();
  await page.waitForURL(`${url}/`);
  await page.goto(`${url}/admin/groups`);
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('Legal team', { exact: true }).fill(name);
  await dialog.getByLabel('Search users').fill(member.email);
  await dialog.getByRole('checkbox', { name: /^Select Direct Recipient/ }).check();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  [groupId] = (await db.select().from(groups).where(eq(groups.name, name))).map(g => g.id);
  assert.ok(groupId);
  assert.equal((await db.select().from(groupMembers).where(eq(groupMembers.groupId, groupId)))[0].userId, member.id);
  await page.getByText(name, { exact: true }).click();
  assert.equal(await dialog.getByRole('checkbox', { name: /^Select Direct Recipient/ }).isChecked(), true);
  await dialog.getByRole('button', { name: 'Remove Direct Recipient', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal((await db.select().from(groupMembers).where(eq(groupMembers.groupId, groupId))).length, 0);
  await page.goto(`${url}/bots/${botId}/edit`);
  await page.getByLabel('Who can use it').click();
  await page.locator('[role="option"][data-value="groups"]').click();
  await page.getByLabel('Search users').fill(member.email);
  await page.getByRole('checkbox', { name: /^Select Direct Recipient/ }).check();
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await page.getByText('Bot updated', { exact: true }).waitFor();
  assert.equal((await db.select().from(botUserAccess).where(eq(botUserAccess.botId, botId)))[0].userId, member.id);
  await page.reload();
  assert.equal(await page.getByRole('checkbox', { name: /^Select Direct Recipient/ }).isChecked(), true);
  await page.getByLabel('Who can use it').click();
  await page.locator('[role="option"][data-value="private"]').click();
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await page.getByText('Bot updated', { exact: true }).waitFor();
  assert.equal((await db.select().from(botUserAccess).where(eq(botUserAccess.botId, botId))).length, 0);
  console.log('Browser verified: group add/remove, saved membership reload, users-only bot sharing, saved audience reload, private audience revocation.');
} catch (error) {
  console.error("Browser failed at", page?.url(), await page?.locator("body").innerText());
  throw error;
} finally {
  await browser?.close();
  if (botId) await db.delete(bots).where(eq(bots.id, botId));
  if (groupId) await db.delete(groups).where(eq(groups.id, groupId));
  if (appId) await db.delete(aiApps).where(eq(aiApps.id, appId));
  if (userIds.length) { await db.delete(users).where(inArray(users.id, userIds)); await db.delete(localAuthBootstrap); }
  await pool.end();
}
