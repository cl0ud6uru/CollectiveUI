import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { mkdir } from "node:fs/promises";
import { hashPassword } from "../../src/lib/auth/password";
import { choose, send } from "./helpers";

test.skip(process.env.DEFAULT_START_BROWSER !== "1", "Requires isolated local fixtures");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const password = "Synthetic-start-browser!42";
const shots = "/tmp/collective-default-start-screenshots";
const model = "startNative", shared = "startShared", coordinator = "startCoordinator";
async function login(page: Page, role = "member") {
  await page.goto("/login");
  await page.getByLabel("Local username or email").fill(`start-${role}`);
  await page.getByLabel("Local password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in with local account" }).click();
  await page.waitForURL(url => url.pathname !== "/login");
}
async function prefs(value: object, role = "member") { await pool.query("UPDATE users SET prefs=$1 WHERE id=$2", [JSON.stringify(value), `start-${role}`]); }
async function setting(key: string, value: object) {
  await pool.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [key, JSON.stringify(value)]);
}
async function ownPrefs(role = "member") { return (await pool.query("SELECT prefs FROM users WHERE id=$1", [`start-${role}`])).rows[0].prefs; }
test.beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/collective_default_start_browser_test") throw new Error("Named disposable start database required");
  const hash = await hashPassword(password);
  await pool.query("DELETE FROM users WHERE id IN ('start-admin','start-member')");
  await pool.query("DELETE FROM ai_apps WHERE id IN ('startNative','startHermes')");
  await pool.query("DELETE FROM auth_throttle");
  for (const role of ["admin", "member"]) {
    const id = `start-${role}`;
    await pool.query("INSERT INTO users(id,upn,name,identity_realm,auth_source,is_admin) VALUES($1,$2,$3,'local','local',$4)", [id, `local:${id}`, `Start ${role}`, role === "admin"]);
    await pool.query("INSERT INTO local_credentials(user_id,username,password_hash,must_change_password) VALUES($1,$1,$2,false)", [id, hash]);
    await pool.query("INSERT INTO local_login_aliases(login,user_id) VALUES($1,$1)", [id]);
  }
  await pool.query("INSERT INTO ai_apps(id,name,provider,model,base_url,is_public,supports_tools) VALUES('startNative','Native model','openai-compatible','mock-gpt','http://127.0.0.1:4068/v1',true,true),('startHermes','Hermes backend','hermes','fixture','http://127.0.0.1:1',true,true)");
  for (const [id, name, visibility, appId] of [[shared, "Shared specialist", "org", model], [coordinator, "Coordinator", "org", model], ["startPrivate", "Private marker 4932", "private", model], ["startHermesBot", "Hermes specialist", "org", "startHermes"]]) {
    await pool.query("INSERT INTO bots(id,owner_id,name,visibility,app_id) VALUES($1,'start-admin',$2,$3,$4)", [id, name, visibility, appId]);
  }
  await setting("branding", { defaultAppId: model });
  await setting("coordinator", { enabled: false, defaultBotId: null, starterBotId: null });
  await mkdir(shots, { recursive: true });
});
test.afterAll(async () => { await pool.end(); });
test.describe.configure({ mode: "serial" });

test("admin bot defaults use labelled option groups and coexist with coordinator setup", async ({ page }) => {
  await login(page, "admin"); await page.goto("/admin/settings");
  const field = page.getByLabel("Start new chats with", { exact: true });
  await field.click();
  await expect(page.getByRole("group", { name: "Models", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Shared bots", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Private marker 4932", exact: true })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "Hermes backend", exact: true })).toHaveCount(0);
  await page.keyboard.press("End"); await page.keyboard.press("Enter");
  await expect(field).toContainText("Shared specialist");
  await page.getByRole("button", { name: "Save branding", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Branding saved" })).toBeVisible();
  expect((await pool.query("SELECT value FROM settings WHERE key='branding'")).rows[0].value).toMatchObject({ defaultBotId: shared });
  await page.getByLabel("Setup", { exact: true }).selectOption("existing");
  await page.getByLabel("Coordinator bot", { exact: true }).selectOption(coordinator);
  await page.getByRole("button", { name: "Save coordinator", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Default coordinator saved" })).toBeVisible();
  await page.screenshot({ path: `${shots}/admin-defaults.png`, fullPage: true });
});

test("personal choices override coordinator entry; fresh bot chats preserve both canonical homes", async ({ page }) => {
  await login(page); await page.waitForURL(/\/c\//);
  const coordinatorHome = page.url().split("/c/")[1];
  await page.goto("/settings");
  const field = page.getByLabel("Start new chats with", { exact: true });
  await choose(page, field, `app:${model}`);
  await expect.poll(ownPrefs).toMatchObject({ defaultAppId: model });
  await page.goto("/"); await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button", { name: "Native model", exact: true })).toBeVisible();
  await page.goto(`/?bot=${shared}`); await page.waitForURL(/\/c\//);
  const specialistHome = page.url().split("/c/")[1];
  await send(page, "Keep this canonical home history");
  await expect.poll(async () => (await pool.query("SELECT status FROM agent_runs WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 1", [specialistHome])).rows[0]?.status).toBe("succeeded");
  const before = (await pool.query("SELECT current_leaf_id FROM conversations WHERE id=$1", [specialistHome])).rows[0];
  await page.goto("/settings"); await choose(page, field, `bot:${shared}`);
  await expect.poll(ownPrefs).toMatchObject({ defaultBotId: shared });
  expect((await ownPrefs()).defaultAppId).toBeUndefined();
  await page.goto("/"); await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("Keep this canonical home history", { exact: true })).toHaveCount(0);
  await send(page, "A fresh default bot conversation"); await page.waitForURL(/\/c\//);
  const fresh = page.url().split("/c/")[1]; expect(fresh).not.toBe(specialistHome);
  await expect.poll(async () => (await pool.query("SELECT status FROM agent_runs WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 1", [fresh])).rows[0]?.status).toBe("succeeded");
  expect((await pool.query("SELECT bot_id,is_bot_home,source FROM conversations WHERE id=$1", [fresh])).rows[0]).toEqual({ bot_id: shared, is_bot_home: false, source: "chat" });
  expect((await pool.query("SELECT current_leaf_id FROM conversations WHERE id=$1", [specialistHome])).rows[0]).toEqual(before);
  await page.goto(`/?bot=${shared}`); await expect(page).toHaveURL(new RegExp(`/c/${specialistHome}$`));
  await page.goto("/settings"); await choose(page, field, "");
  await expect.poll(ownPrefs).toEqual({});
  await page.goto("/"); await expect(page).toHaveURL(new RegExp(`/c/${coordinatorHome}$`));
});

test("unavailable defaults block without fallback and the explicit model entry remains model-only", async ({ page }) => {
  await prefs({ defaultBotId: shared }); await login(page);
  for (const change of ["disabled", "connection", "missing-connection", "hidden", "private", "deleted"]) {
    if (change === "disabled") await pool.query("UPDATE bots SET enabled=false WHERE id=$1", [shared]);
    if (change === "connection") await pool.query("UPDATE ai_apps SET enabled=false WHERE id=$1", [model]);
    if (change === "missing-connection") await pool.query("UPDATE bots SET app_id=NULL WHERE id=$1", [shared]);
    if (change === "hidden") await pool.query("INSERT INTO user_bot_prefs(user_id,bot_id,hidden) VALUES('start-member',$1,true)", [shared]);
    if (change === "private") await prefs({ defaultBotId: "startPrivate" });
    if (change === "deleted") await prefs({ defaultBotId: "deleted" });
    await page.goto("/");
    await expect(page.getByRole("status").filter({ hasText: "Your default bot is unavailable" })).toBeVisible();
    await expect(page.getByLabel("Message", { exact: true })).toBeDisabled();
    await expect(page.getByText("Private marker 4932", { exact: true })).toHaveCount(0);
    await pool.query("UPDATE bots SET enabled=true,app_id=$2 WHERE id=$1", [shared, model]);
    await pool.query("UPDATE ai_apps SET enabled=true WHERE id=$1", [model]);
    await pool.query("DELETE FROM user_bot_prefs WHERE user_id='start-member'");
    await prefs({ defaultBotId: shared });
  }
  await page.goto("/?chat=model");
  await expect(page.getByRole("button", { name: "Native model", exact: true })).toBeVisible();
  await page.goto("/settings"); await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Start new chats with", { exact: true }).click();
  await expect(page.getByRole("group", { name: "Models", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Bots", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${shots}/mobile-groups.png`, fullPage: true });
});

test("legacy model preferences remain valid and Hermes is offered through bots only", async ({ page }) => {
  await prefs({ defaultAppId: model, memoryEnabled: false, customInstructions: "Keep old instructions" }); await login(page);
  await expect(page.getByRole("button", { name: "Native model", exact: true })).toBeVisible();
  await page.goto("/settings"); await choose(page, page.getByLabel("Start new chats with", { exact: true }), "bot:startHermesBot");
  await expect.poll(ownPrefs).toEqual({ defaultBotId: "startHermesBot", memoryEnabled: false, customInstructions: "Keep old instructions" });
  await page.goto("/"); await expect(page.getByLabel("Message", { exact: true })).toBeEnabled();
  await prefs({ defaultAppId: "startHermes" }); await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "agent backend for bots" })).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toBeDisabled();
  const response = await page.request.post("/api/chat", { data: { conversationId: "startBlockedHermes", appId: "startHermes", message: { id: "startBlockedMessage", role: "user", parts: [{ type: "text", text: "No external call" }] } } });
  expect(response.status()).toBe(400);
  expect((await pool.query("SELECT id FROM conversations WHERE id='startBlockedHermes'")).rows).toHaveLength(0);
  await page.goto("/settings"); await page.getByLabel("Start new chats with", { exact: true }).click();
  const unavailable = page.getByRole("option", { name: "Unavailable default — choose a model or bot", exact: true });
  await expect(unavailable).toHaveAttribute("data-disabled", "");
  await page.keyboard.press("Home"); await page.keyboard.press("Enter");
  await expect.poll(ownPrefs).toEqual({});
});
