import { choose } from "./helpers";
import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { mkdir } from "node:fs/promises";
import { hashPassword } from "../../src/lib/auth/password";
import { sealIdentitySecret } from "../../src/lib/mcp/identity";

// UI-only connector fixtures: no upstream MCP or model is contacted.
test.skip(process.env.SERVICE_BOT_BROWSER !== "1", "Requires isolated synthetic installation");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const password = "Synthetic-service-browser!42";
const screenshots = "/tmp/collective-service-bot-screenshots";
const scope = JSON.stringify([{ path: "project", source: "constant", value: "IT" }, { path: "requester", source: "caller.upn" }]);
const tool = { name: "create_ticket", description: "Create a scoped IT ticket", inputSchema: { type: "object", required: ["project", "requester"], properties: { project: { type: "string" }, requester: { type: "string" }, summary: { type: "string" } } } };
async function login(page: Page, username: string) {
  await page.goto("/login");
  await page.getByLabel("Local username or email").fill(username);
  await page.getByLabel("Local password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in with local account" }).click();
  await page.waitForURL("/");
}
test.beforeAll(async () => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/collective_service_bot_browser_test") throw new Error("Disposable service bot browser DB required");
  const hash = await hashPassword(password);
  await pool.query("DELETE FROM users WHERE id IN ('service-browser-admin','service-browser-user')");
  await pool.query("DELETE FROM mcp_servers WHERE id LIKE 'service-browser-%'");
  await pool.query("DELETE FROM ai_apps WHERE id='service-browser-model'");
  for (const role of ["admin", "user"]) {
    const id = `service-browser-${role}`, username = `fixture-${role}`;
    await pool.query("INSERT INTO users(id,upn,name,identity_realm,auth_source,is_admin) VALUES ($1,$2,$3,'local','local',$4)", [id, `local:${username}`, `Fixture ${role}`, role === "admin"]);
    await pool.query("INSERT INTO local_credentials(user_id,username,password_hash,must_change_password) VALUES ($1,$2,$3,false)", [id, username, hash]);
    await pool.query("INSERT INTO local_login_aliases(login,user_id) VALUES ($1,$2)", [username, id]);
  }
  await pool.query("INSERT INTO ai_apps(id,name,provider,model,base_url,supports_tools) VALUES ('service-browser-model','Synthetic native model','openai-compatible','synthetic','https://unused.invalid',true)");
  for (const [id, name, status, isPublic] of [["private", "Private tickets", "enabled", false], ["public", "Public connector", "enabled", true], ["draft", "Draft connector", "draft", true]] as const) {
    const serverId = `service-browser-${id}`;
    await pool.query("INSERT INTO mcp_servers(id,name,url,status,is_public,trust,identity_header,identity_secret_enc,tools_snapshot) VALUES ($1,$2,'https://unused.invalid/mcp',$3,$4,'trusted','X-Portal-Identity',$5,$6)", [serverId, name, status, isPublic, sealIdentitySecret(serverId, "synthetic-browser-identity-secret"), JSON.stringify([tool])]);
  }
  await mkdir(screenshots, { recursive: true });
});
test.afterAll(async () => { await pool.end(); });

test("admin publishes scoped bot; user can discover/use but cannot edit or take its connector; revoke shows needs review", async ({ page, browser }) => {
  await login(page, "fixture-admin");
  await page.goto("/admin/mcp");
  await page.getByRole("row").filter({ hasText: "Private tickets" }).getByText("Private tickets", { exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Direct access")).toHaveText("No ordinary users — admins only");
  await expect(dialog.getByText("Authorized bots", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goto("/bots/new");
  await page.getByRole("button", { name: "configure", exact: true }).click();
  await page.getByPlaceholder("Name your bot").fill("Scoped IT tickets");
  await choose(page, page.getByLabel("Model connection"), "service-browser-model");
  await choose(page, page.getByLabel("Who can use it"), "org");
  await choose(page, page.getByLabel("Connector permissions"), "service");
  await page.getByRole("radio", { name: "Moss", exact: true }).check();
  await page.getByLabel("Private tickets (MCP)", { exact: true }).check();
  await expect(page.getByLabel("Draft connector (MCP)", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/bots\/.+\/edit/);
  const botId = /\/bots\/([^/]+)\/edit/.exec(page.url())![1];
  await page.getByText("Reviewed tool definition", { exact: true }).click();
  await expect(page.getByText('"project": {', { exact: false })).toBeVisible();
  await page.getByLabel("create_ticket constraints").fill(scope);
  await page.getByRole("button", { name: "Publish service bot", exact: true }).click();
  await expect(page.getByText("Service bot published with these exact capabilities", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Published.*Users in the bot audience/)).toBeVisible();
  await page.getByRole("button", { name: "Publish service bot", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${screenshots}/admin-published-bot.png`, fullPage: true });
  const origin = new URL(page.url()).origin;
  const petEndpoint = `/api/bots/${botId}/pet`;
  const preserved = async () => ({ bot: (await pool.query("SELECT revision,published_revision,published_config_hash FROM bots WHERE id=$1", [botId])).rows,
    grants: (await pool.query("SELECT * FROM bot_mcp_grants WHERE bot_id=$1 ORDER BY id", [botId])).rows });
  const beforePet = await preserved();
  await page.getByRole("button", { name: "Pet avatar settings for Scoped IT tickets", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Animation", exact: true })).toBeEnabled();
  await page.getByText("Shared bot pet", { exact: true }).click();
  await page.getByRole("radio", { name: "Ember", exact: true }).check();
  await page.getByRole("button", { name: "Save bot pet", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Shared bot pet saved" })).toBeVisible();
  expect(await preserved()).toEqual(beforePet); await page.keyboard.press("Escape");
  const context = await browser.newContext(); const member = await context.newPage();
  try {
    await login(member, "fixture-user");
    await member.goto(`/bots/${botId}`);
    await expect(member.getByText("Admin-managed service bot · direct chats only", { exact: true })).toBeVisible();
    await expect(member.getByRole("link", { name: "Edit", exact: true })).toHaveCount(0);
    await expect(member.getByText(/create_ticket · write · asks every time/)).toBeVisible();
    await member.screenshot({ path: `${screenshots}/member-capabilities.png`, fullPage: true });
    await member.getByRole("link", { name: "Open home chat", exact: true }).click();
    await expect(member.getByLabel("Message", { exact: true })).toBeVisible();
    await expect(member.locator(`header [data-bot-avatar="${botId}"]`)).toHaveAttribute("data-pet-appearance", "ember");
    await member.getByRole("button", { name: "Show bot details" }).click();
    await member.getByRole("button", { name: "Pet avatar settings for Scoped IT tickets", exact: true }).click();
    await expect(member.getByRole("combobox", { name: "Animation", exact: true })).toBeEnabled();
    await expect(member.getByRole("radio")).toHaveCount(0);
    expect((await member.request.patch(petEndpoint, { headers: { origin }, data: { mode: "off", appearance: "moss", catalogId: null, motion: "auto" } })).status()).toBe(403);
    expect((await member.request.put(`${petEndpoint}/default`, { headers: { origin }, data: { appearance: "moss", catalogId: null } })).status()).toBe(403);
    expect((await member.request.patch(`${petEndpoint}/motion`, { headers: { origin }, data: { motion: "still" } })).status()).toBe(200);
    await member.keyboard.press("Escape");
    // Stored synthetic approval card: verify the real chat UI without invoking a connector.
    const approvalParts = [{ type: "dynamic-tool", toolName: "private_tickets__create_ticket", toolCallId: "fixture-call", state: "approval-requested", input: { project: "IT", requester: "local:fixture-user" }, approval: { id: "fixture-approval", requestReason: "Organization policy requires approval for every call." } }];
    await pool.query("INSERT INTO conversations(id,user_id,bot_id,app_id,title,current_leaf_id) VALUES ('fixtureapprovalchat','service-browser-user',$1,'service-browser-model','Synthetic approval','fixtureapprovalmessage')", [botId]);
    await pool.query("INSERT INTO messages(id,conversation_id,role,parts) VALUES ('fixtureapprovalmessage','fixtureapprovalchat','assistant',$1)", [JSON.stringify(approvalParts)]);
    await member.goto("/c/fixtureapprovalchat");
    await expect(member.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
    await expect(member.getByRole("button", { name: "Always allow", exact: true })).toHaveCount(0);
    await member.getByRole("button", { name: "Show bot details" }).click();
    await expect(member.getByText("Admin-managed service bot. Direct chats only; routines are unavailable.", { exact: true })).toBeVisible();
    await expect(member.getByRole("button", { name: "New routine", exact: true })).toHaveCount(0);
    await member.screenshot({ path: `${screenshots}/member-forced-approval.png`, fullPage: true });
    await member.goto("/bots/new");
    await member.getByRole("button", { name: "configure", exact: true }).click();
    await expect(member.getByLabel("Connector permissions")).toHaveCount(0);
    await expect(member.getByLabel("Private tickets (MCP)", { exact: true })).toHaveCount(0);
    await expect(member.getByLabel("Draft connector (MCP)", { exact: true })).toHaveCount(0);
    await expect(member.getByLabel("Public connector (MCP)", { exact: true })).toBeVisible();
    await member.goto(`/bots/${botId}/edit`);
    await expect(member.getByRole("button", { name: "Publish service bot", exact: true })).toHaveCount(0);
    await page.goto("/admin/mcp");
    await page.getByRole("row").filter({ hasText: "Private tickets" }).getByText("Private tickets", { exact: true }).click();
    await expect(dialog.getByText(/Scoped IT tickets.*create_ticket/)).toBeVisible();
    await dialog.getByRole("button", { name: "Revoke", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${screenshots}/connector-bot-grants.png`, fullPage: true });
    await dialog.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await member.goto(`/bots/${botId}`);
    await expect(member.getByText(/no active capabilities|revoked or changed/)).toBeVisible();
    await member.setViewportSize({ width: 390, height: 844 });
    await member.screenshot({ path: `${screenshots}/member-revoked-mobile.png`, fullPage: true });
    expect(await member.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await pool.query("UPDATE bots SET visibility='private' WHERE id=$1", [botId]);
    await pool.query("UPDATE users SET is_admin=false WHERE id='service-browser-admin'");
    expect((await page.request.put(`${petEndpoint}/default`, { headers: { origin }, data: { appearance: "moss", catalogId: null } })).status()).toBe(403);
    expect((await page.request.get(`${petEndpoint}?editor=1`)).status()).toBe(403);
  } finally { await context.close(); }
});
