import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { hashPassword } from "../../src/lib/auth/password";
import { choose } from "./helpers";
import { mkdir } from "node:fs/promises";

// This suite writes only synthetic fixtures into its named, disposable database.
test.skip(process.env.MODELS_BROWSER_TEST !== "1", "Disposable synthetic installation required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const password = "Synthetic-model-routing!42";
const screenshots = "/tmp/collective-models-screenshots";
async function login(page: Page, role: string) {
  await page.goto("/login");
  await page.getByLabel("Local username or email").fill(`models-${role}`);
  await page.getByLabel("Local password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in with local account" }).click();
  await page.waitForURL("/");
}
async function fixtureSetting(key: string, value: unknown) {
  await pool.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [key, JSON.stringify(value)]);
}
test.beforeAll(async () => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/collective_models_test") throw new Error("Disposable model fixture database required");
  await mkdir(screenshots, { recursive: true });
  const hash = await hashPassword(password);
  await pool.query("DELETE FROM users WHERE id IN ('models-admin','models-member')");
  await pool.query("DELETE FROM ai_apps WHERE id LIKE 'models-%'");
  for (const role of ["admin", "member"]) {
    await pool.query("INSERT INTO users(id,upn,name,identity_realm,auth_source,is_admin) VALUES($1,$2,$3,'local','local',$4)", [`models-${role}`, `local:models-${role}`, `Models ${role}`, role === "admin"]);
    await pool.query("INSERT INTO local_credentials(user_id,username,password_hash,must_change_password) VALUES($1,$1,$2,false)", [`models-${role}`, hash]);
    await pool.query("INSERT INTO local_login_aliases(login,user_id) VALUES($1,$1)", [`models-${role}`]);
  }
  await pool.query("DELETE FROM auth_throttle");
  await pool.query("INSERT INTO ai_apps(id,name,provider,model,base_url,is_public,provider_config) VALUES ('models-native','Team model','openai-compatible','mock-gpt','http://127.0.0.1:4020/v1',true,'{}'),('models-hermes','Manual Hermes','hermes','coder','http://127.0.0.1:18642',true,'{\"profile\":\"coder\"}'),('models-managed','Managed Hermes','hermes','managed','http://127.0.0.1:18643',true,'{\"managed\":true}'),('models-private','Private model','openai-compatible','secret-model','http://127.0.0.1:4020/v1',false,'{}')");
  await pool.query("INSERT INTO bots(id,owner_id,name,app_id,visibility) VALUES ('modelsnativebot','models-member','Native assistant','models-native','org'),('modelshermesbot','models-member','Hermes assistant','models-hermes','org')");
  await pool.query("INSERT INTO conversations(id,user_id,app_id,title,current_leaf_id) VALUES('modelslegacychat','models-member','models-hermes','Legacy Hermes history','modelslegacyreply')");
  await pool.query("INSERT INTO messages(id,conversation_id,role,parts,parent_id) VALUES('modelslegacyprompt','modelslegacychat','user','[{\"type\":\"text\",\"text\":\"Keep my original prompt\"}]',null),('modelslegacyreply','modelslegacychat','assistant','[{\"type\":\"text\",\"text\":\"Keep my original Hermes answer\"}]','modelslegacyprompt')");
  await pool.query("UPDATE messages SET parts=parts || $1::jsonb WHERE id='modelslegacyreply'", [JSON.stringify([{ type: "dynamic-tool", toolName: "hermes__terminal", toolCallId: "modelslegacytool", state: "approval-requested", input: { command: "echo synthetic", reason: "Saved approval" }, approval: { id: "modelslegacyapproval" } }])]);
  await fixtureSetting("branding", { defaultAppId: "models-native" });
});
test.afterAll(async () => { await pool.end(); });

test("member New Chat, stale targets, history and direct API reject Hermes without mutation", async ({ page }) => {
  await login(page, "member");
  await page.getByRole("button", { name: "Team model", exact: true }).click();
  await expect(page.getByText("Models", { exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem").filter({ hasText: "mock-gpt" })).toBeVisible();
  for (const label of ["Manual Hermes", "Managed Hermes", "Private model"]) await expect(page.getByRole("menuitem").filter({ hasText: label })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${screenshots}/01-new-chat.png`, fullPage: true });
  // No live provider calls: this endpoint is the checked-in local mock and local worker.
  await page.getByLabel("Message", { exact: true }).fill("Hello model routing");
  await page.getByLabel("Send message").click();
  await expect(page.getByText("Hello model routing", { exact: false }).last()).toBeVisible();
  await expect.poll(async () => (await pool.query("SELECT status FROM agent_runs WHERE conversation_id = (SELECT id FROM conversations WHERE user_id='models-member' AND app_id='models-native' ORDER BY created_at DESC LIMIT 1) ORDER BY created_at DESC LIMIT 1")).rows[0]?.status, { timeout: 30_000 }).toBe("succeeded");
  expect((await pool.query("SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.user_id='models-member' AND c.app_id='models-native' AND m.role='assistant'")).rowCount).toBeGreaterThan(0);
  for (const appId of ["models-hermes", "models-managed"]) {
    await page.goto(`/?app=${appId}`);
    await expect(page.getByRole("status").filter({ hasText: "Hermes is an agent backend for bots" })).toBeVisible();
    await expect(page.getByLabel("Message", { exact: true })).toBeDisabled();
    const id = appId === "models-hermes" ? "modelsnewmanual" : "modelsnewmanaged";
    const response = await page.request.post("/api/chat", { data: { conversationId: id, appId, message: { id: `${id}prompt`, role: "user", parts: [{ type: "text", text: "Blocked" }] } } });
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toContain("agent backend for bots");
    expect((await pool.query("SELECT id FROM conversations WHERE id=$1", [id])).rowCount).toBe(0);
  }
  await page.goto("/c/modelslegacychat");
  await expect(page.getByText("Keep my original Hermes answer", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "its session is not transferred" })).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Regenerate", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeDisabled();
  await page.screenshot({ path: `${screenshots}/02-history.png`, fullPage: true });
  for (const data of [
    { message: { id: "modelsretrymsg", role: "user", parts: [{ type: "text", text: "Retry" }] } },
    { regenerate: true, parentId: "modelslegacyprompt" },
    { message: { id: "modelslegacyreply", role: "assistant", parts: [] } },
  ]) expect((await page.request.post("/api/chat", { data: { conversationId: "modelslegacychat", ...data } })).status()).toBe(400);
  expect((await page.request.post("/api/chat/commands", { data: { conversationId: "modelslegacychat", text: "/new", revision: 0, newConversationId: "modelslegacynew" } })).status()).toBe(400);
  expect((await pool.query("SELECT id FROM messages WHERE conversation_id='modelslegacychat'")).rowCount).toBe(2);
  expect((await pool.query("SELECT id FROM agent_runs WHERE conversation_id='modelslegacychat'")).rowCount).toBe(0);
  await page.goto("/settings");
  await page.getByLabel("Start new chats with").click();
  await expect(page.getByRole("option", { name: "Manual Hermes" })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "Managed Hermes" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.goto("/admin/apps");
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toHaveCount(0);
});

test("admin connections separate models/backends and builder choices preserve both engines", async ({ page }) => {
  await login(page, "admin");
  await page.goto("/admin/apps");
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
  const models = page.getByRole("region", { name: "Models", exact: true });
  const backends = page.getByRole("region", { name: "Agent backends", exact: true });
  await expect(models.getByRole("button", { name: "Edit Team model", exact: true })).toBeVisible();
  await expect(models.getByText("Manual Hermes", { exact: true })).toHaveCount(0);
  await expect(backends.getByRole("button", { name: "Edit Manual Hermes", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add agent backend", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Bot-only");
  await expect(page.getByLabel("Profile model route", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Add model connection", exact: true }).click();
  await page.getByLabel("Model provider", { exact: true }).click();
  await expect(page.getByRole("option", { name: "Hermes Agent", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
  await page.screenshot({ path: `${screenshots}/03-connections.png`, fullPage: true });
  await page.goto("/bots/modelsnativebot/edit");
  await expect(page.getByLabel("Bot engine", { exact: true })).toContainText("Native");
  await page.getByLabel("Model connection", { exact: true }).click();
  await expect(page.getByRole("option").filter({ hasText: "Manual Hermes" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await choose(page, page.getByLabel("Bot engine", { exact: true }), "hermes");
  await expect(page.getByLabel("Agent backend connection", { exact: true })).toContainText("Choose a connection");
  await choose(page, page.getByLabel("Agent backend connection", { exact: true }), "models-hermes");
  await expect(page.getByText("Tools, memory, skills and persona live in Hermes", { exact: false })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/04-bot-engine.png`, fullPage: true });
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await expect.poll(async () => (await pool.query("SELECT app_id FROM bots WHERE id='modelsnativebot'")).rows[0]?.app_id).toBe("models-hermes");
  await page.reload();
  await expect(page.getByLabel("Bot engine", { exact: true })).toContainText("Hermes");
  await choose(page, page.getByLabel("Bot engine", { exact: true }), "native");
  await expect(page.getByRole("button", { name: "Update", exact: true })).toBeDisabled();
  await choose(page, page.getByLabel("Model connection", { exact: true }), "models-native");
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await expect.poll(async () => (await pool.query("SELECT app_id FROM bots WHERE id='modelsnativebot'")).rows[0]?.app_id).toBe("models-native");
  await page.goto("/bots/modelshermesbot/edit");
  await expect(page.getByLabel("Bot engine", { exact: true })).toContainText("Hermes");
  await expect(page.getByLabel("Agent backend connection", { exact: true })).toContainText("Manual Hermes");
  await page.goto("/?bot=modelshermesbot");
  await page.waitForURL(/\/c\//);
  await page.getByLabel("Message", { exact: true }).fill("/help");
  await page.keyboard.press("Escape");
  await page.getByLabel("Send message").click();
  await expect(page.getByText("Hermes commands", { exact: true })).toBeVisible();
  expect((await pool.query("SELECT r.id FROM agent_runs r JOIN conversations c ON c.id=r.conversation_id WHERE c.bot_id='modelshermesbot'")).rowCount).toBe(0);
  await page.goto("/admin/settings");
  await page.getByLabel("Start new chats with", { exact: true }).click();
  await expect(page.getByRole("option", { name: "Manual Hermes", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.goto("/admin/tools");
  await page.getByLabel("Utility model", { exact: true }).click();
  await expect(page.getByRole("option", { name: "Manual Hermes", exact: true })).toHaveCount(0);
});

test("invalid defaults do not switch providers; empty state and mobile remain actionable", async ({ page }) => {
  await fixtureSetting("branding", { defaultAppId: "models-hermes" });
  await login(page, "member");
  await expect(page.getByRole("status").filter({ hasText: "Your default model is unavailable" })).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Select a model", exact: true }).click();
  await page.getByRole("menuitem").filter({ hasText: "Team model" }).click();
  await expect(page.getByLabel("Message", { exact: true })).toBeEnabled();
  await expect(page.getByText("Your default model is unavailable", { exact: false })).toHaveCount(0);
  await fixtureSetting("branding", {});
  await pool.query("UPDATE ai_apps SET enabled=false WHERE id='models-native'");
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "No models are available" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Browse bots", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${screenshots}/05-mobile-empty.png`, fullPage: true });
  await pool.query("UPDATE ai_apps SET enabled=true WHERE id='models-native'");
  await fixtureSetting("branding", { defaultAppId: "models-native" });
  await page.goto("/bots/modelshermesbot/edit");
  await expect(page.getByLabel("Bot engine", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel("Bot engine", { exact: true }).scrollIntoViewIfNeeded();
  await page.getByLabel("Bot engine", { exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("option", { name: "Hermes", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${screenshots}/06-mobile-builder.png`, fullPage: true });
});
