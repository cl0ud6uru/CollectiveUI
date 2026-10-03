import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { mkdir } from "node:fs/promises";
import { hashPassword } from "../../src/lib/auth/password";
import { choose } from "./helpers";

test.skip(process.env.COORDINATOR_BROWSER !== "1", "Requires isolated synthetic installation");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const password = "Synthetic-coordinator!42";
const screenshots = "/tmp/collective-coordinator-screenshots";
async function login(page: Page, name: string) {
  await page.goto("/login");
  await page.getByLabel("Local username or email").fill(name);
  await page.getByLabel("Local password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in with local account" }).click();
  await page.waitForURL(url => url.pathname !== "/login", { timeout: 30_000 });
}
async function config(enabled: boolean, id: string | null) {
  await pool.query("INSERT INTO settings(key,value) VALUES ('coordinator',$1) ON CONFLICT(key) DO UPDATE SET value=$1", [JSON.stringify({ enabled, defaultBotId: id, starterBotId: null })]);
}

test.beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/collective_coordinator_browser_test") throw new Error("Disposable coordinator browser DB required");
  const hash = await hashPassword(password);
  await pool.query("DELETE FROM users WHERE id LIKE 'coordinator-browser-%'");
  await pool.query("DELETE FROM ai_apps WHERE id='coordinator-browser-model'");
  await pool.query("DELETE FROM settings WHERE key='coordinator'");
  await pool.query("DELETE FROM auth_throttle");
  for (const role of ["admin", "alice", "bob"]) {
    const id = `coordinator-browser-${role}`;
    await pool.query("INSERT INTO users(id,upn,name,identity_realm,auth_source,is_admin) VALUES ($1,$2,$3,'local','local',$4)", [id, `local:fixture-${role}`, `Fixture ${role}`, role === "admin"]);
    await pool.query("INSERT INTO local_credentials(user_id,username,password_hash,must_change_password) VALUES ($1,$2,$3,false)", [id, `fixture-${role}`, hash]);
    await pool.query("INSERT INTO local_login_aliases(login,user_id) VALUES ($1,$2)", [`fixture-${role}`, id]);
  }
  await pool.query("INSERT INTO ai_apps(id,name,provider,model,base_url,supports_tools,is_public) VALUES ('coordinator-browser-model','Synthetic native model','openai-compatible','synthetic','http://127.0.0.1:1',true,true)");
  for (const [id, name, visibility] of [["lloyd", "Lloyd GPT", "org"], ["specialist", "Direct specialist", "org"], ["hidden", "Secret coordinator marker 9876", "private"]]) {
    await pool.query("INSERT INTO bots(id,owner_id,name,avatar,instructions,app_id,visibility) VALUES ($1,'coordinator-browser-admin',$2,'blob:hexagon:purple','Keep original personality','coordinator-browser-model',$3)", [`coordinator-browser-${id}`, name, visibility]);
  }
  await mkdir(screenshots, { recursive: true });
});
test.afterAll(async () => { await pool.end(); });
test.describe.configure({ mode: "serial" });

test("keyboard admin setup creates one optional model-less Queen, allows rename/model configuration, choose existing and off", async ({ page }) => {
  await login(page, "fixture-admin");
  await page.goto("/admin/settings");
  const mode = page.getByLabel("Setup", { exact: true });
  await mode.focus();
  await page.keyboard.press("End"); await page.keyboard.press("Tab");
  await expect(mode).toHaveValue("starter");
  await expect(page.getByLabel("Starter name")).toBeFocused();
  await expect(page.getByLabel("Model connection", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Create starter and select" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Starter created" })).toBeVisible();
  const cfg = (await pool.query("SELECT value FROM settings WHERE key='coordinator'")).rows[0].value;
  const queen = (await pool.query("SELECT * FROM bots WHERE id=$1", [cfg.starterBotId])).rows[0];
  expect(queen).toMatchObject({ name: "Queen", app_id: null, avatar: "blob:hexagon:purple" });
  await page.reload();
  await expect(mode.locator("option[value=starter]")).toHaveCount(0);
  await page.goto("/");
  await expect(page.getByText(/Queen needs an available model/)).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toHaveCount(0);
  await page.goto(`/bots/${queen.id}/edit`);
  await page.getByRole("button", { name: "configure", exact: true }).click();
  await page.getByPlaceholder("Name your bot").fill("Queen, renamed");
  await choose(page, page.getByLabel("Model connection", { exact: true }), "coordinator-browser-model");
  await page.getByLabel("Allow coordinator delegation", { exact: false }).check();
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await expect.poll(async () => (await pool.query("SELECT name FROM bots WHERE id=$1", [queen.id])).rows[0].name).toBe("Queen, renamed");
  await page.goto("/admin/settings");
  await mode.selectOption("existing");
  await page.getByLabel("Coordinator bot", { exact: true }).selectOption("coordinator-browser-lloyd");
  await page.getByRole("button", { name: "Save coordinator", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Default coordinator saved" })).toBeVisible();
  expect((await pool.query("SELECT instructions FROM bots WHERE id='coordinator-browser-lloyd'")).rows[0].instructions).toBe("Keep original personality");
  await page.screenshot({ path: `${screenshots}/admin-default-coordinator.png`, fullPage: true });
  await mode.selectOption("off");
  await page.getByRole("button", { name: "Save coordinator", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Default coordinator is off" })).toBeVisible();
  expect((await pool.query("SELECT COUNT(*)::int AS n FROM bots WHERE id=$1", [queen.id])).rows[0].n).toBe(1);
});

test("first entry and repeated visits use private homes; specialists and /new remain separate", async ({ page, browser }) => {
  await config(true, "coordinator-browser-lloyd");
  await login(page, "fixture-alice");
  await expect(page).toHaveURL(/\/c\//);
  const home = page.url();
  await expect(page.locator("header").getByRole("heading", { name: "Lloyd GPT", exact: true })).toBeVisible();
  await expect(page.locator('nav a[href="/?bot=coordinator-browser-lloyd"]')).toContainText("Default coordinator");
  await page.goto("/"); await expect(page).toHaveURL(home);
  await page.goto("/?bot=coordinator-browser-specialist");
  await expect(page).not.toHaveURL(home);
  await expect(page.locator("header").getByRole("heading", { name: "Direct specialist", exact: true })).toBeVisible();
  await page.goto(home);
  await page.getByLabel("Message", { exact: true }).fill("/new");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page).not.toHaveURL(home);
  const successor = page.url();
  await page.goto("/"); await expect(page).toHaveURL(successor);
  const context = await browser.newContext();
  try {
    const other = await context.newPage(); await login(other, "fixture-bob");
    await expect(other).toHaveURL(/\/c\//); expect(other.url()).not.toBe(successor);
    expect((await other.request.get(`/api/chat/${successor.split("/c/")[1]}`)).status()).toBe(404);
    await other.goto("/admin/settings"); await expect(other).not.toHaveURL(/\/admin/);
  } finally { await context.close(); }
});

test("mobile setup and home navigation work; inaccessible, deleted or hidden defaults reveal no metadata or fallback model", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await config(true, "coordinator-browser-lloyd");
  await login(page, "fixture-admin");
  await page.goto("/admin/settings");
  await page.getByLabel("Setup", { exact: true }).focus();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${screenshots}/mobile-admin-coordinator.png`, fullPage: true });
  await page.goto("/"); await expect(page).toHaveURL(/\/c\//);
  await page.getByRole("button", { name: "Open sidebar" }).click();
  await page.locator('nav a[href="/?bot=coordinator-browser-specialist"]:visible').click();
  await expect(page.getByRole("button", { name: "Close sidebar" })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${screenshots}/mobile-specialist-home.png`, fullPage: true });
  // Admin oversight does not automatically expose another user's private coordinator.
  await pool.query("UPDATE bots SET owner_id='coordinator-browser-bob' WHERE id='coordinator-browser-hidden'");
  for (const id of ["coordinator-browser-hidden", "deleted-coordinator"]) {
    await config(true, id); await page.goto("/");
    await expect(page.getByText("Your default coordinator is unavailable. Choose a bot or model to start a chat.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Select a model", exact: true })).toBeVisible();
    await expect(page.getByText("Secret coordinator marker 9876", { exact: false })).toHaveCount(0);
  }
  await pool.query("INSERT INTO user_bot_prefs(user_id,bot_id,hidden) VALUES ('coordinator-browser-admin','coordinator-browser-lloyd',true) ON CONFLICT(user_id,bot_id) DO UPDATE SET hidden=true");
  await config(true, "coordinator-browser-lloyd"); await page.goto("/");
  await expect(page.getByText("Your default coordinator is unavailable. Choose a bot or model to start a chat.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Select a model", exact: true })).toBeVisible();
});
