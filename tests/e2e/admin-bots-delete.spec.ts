import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { hashPassword } from "../../src/lib/auth/password";

test.skip(process.env.BOT_DELETE_BROWSER !== "1", "Requires the dedicated disposable bot-delete fixture installation");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const run = `delete-${randomUUID()}`;
const adminId = `${run}-admin`;
const ownerId = `${run}-owner`;
const appId = `${run}-app`;
const protectedAppId = `${run}-protected-app`;
const password = "Disposable bot deletion fixture passphrase!";
let disposableDatabaseVerified = false;
const names = { cancel: "Research Assistant", retry: "Release Notes", success: "Disposable Bot", protected: "Protected Hermes", editor: "Editor Fixture" };
type Fixture = keyof typeof names;
const botId = (fixture: Fixture) => `${run}-${fixture}`;
const label = (fixture: Fixture) => `Delete bot “${names[fixture]}”`;
const row = (page: Page, fixture: Fixture) => page.getByRole("row").filter({ has: page.getByRole("link", { name: names[fixture] }) });
const exists = async (fixture: Fixture) => (await pool.query("SELECT id FROM bots WHERE id=$1", [botId(fixture)])).rowCount;

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Local username or email").fill(adminId);
  await page.getByLabel("Local password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in with local account" }).click();
  await page.waitForURL("/", { timeout: 15_000 });
  await page.goto("/admin/bots");
  await expect(page.getByRole("heading", { name: "Bots", exact: true })).toBeVisible();
}

test.beforeAll(async () => {
  const database = new URL(process.env.DATABASE_URL!);
  const origin = new URL(process.env.BASE_URL ?? "http://localhost:3000");
  if (!["localhost", "127.0.0.1"].includes(database.hostname) || database.pathname !== "/collective_bot_delete_test" ||
      !["localhost", "127.0.0.1"].includes(origin.hostname)) throw new Error("Only the dedicated local disposable bot-delete installation is allowed");
  disposableDatabaseVerified = true;
  const hash = await hashPassword(password);
  for (const id of [adminId, ownerId]) {
    await pool.query("INSERT INTO users (id,upn,name,identity_realm,auth_source,is_admin) VALUES ($1,$1,$2,'local','local',$3)", [id, id === adminId ? "Fixture Administrator" : "Fixture Owner", id === adminId]);
  }
  await pool.query("INSERT INTO local_credentials (user_id,username,password_hash,must_change_password) VALUES ($1,$1,$2,false)", [adminId, hash]);
  await pool.query("INSERT INTO local_login_aliases (login,user_id) VALUES ($1,$1)", [adminId]);
  await pool.query("INSERT INTO ai_apps (id,name,provider,model,is_public) VALUES ($1,'Fixture Model','openai','fixture',true)", [appId]);
  await pool.query("INSERT INTO ai_apps (id,name,provider,kind,base_url,model,provider_config) VALUES ($1,'Hermes Fixture','hermes','runtime','http://127.0.0.1:19999','fixture',$2)", [protectedAppId, JSON.stringify({ local: { runtimeId: "a".repeat(64), bindingId: "b".repeat(32), ownerId: adminId, botId: botId("protected"), model: "fixture", provider: "openai" } })]);
  for (const fixture of Object.keys(names) as Fixture[]) {
    await pool.query("INSERT INTO bots (id,owner_id,name,app_id,visibility) VALUES ($1,$2,$3,$4,'private')", [botId(fixture), fixture === "protected" ? adminId : ownerId, names[fixture], fixture === "protected" ? protectedAppId : appId]);
  }
  await pool.query("INSERT INTO memories (id,user_id,bot_id,content) VALUES ($1,$2,$3,'Disposable bot memory')", [`${run}-memory`, ownerId, botId("success")]);
  await pool.query("INSERT INTO conversations (id,user_id,bot_id,title) VALUES ($1,$2,$3,'Disposable conversation')", [`${run}-conversation`, ownerId, botId("success")]);
});

test.afterAll(async () => {
  if (!disposableDatabaseVerified) { await pool.end(); return; }
  // Exact IDs created by this run only; never the shared E2E seed's broad deletes.
  await pool.query("DELETE FROM users WHERE id = ANY($1::text[])", [[adminId, ownerId]]);
  await pool.query("DELETE FROM ai_apps WHERE id = ANY($1::text[])", [[appId, protectedAppId]]);
  await pool.end();
});

test.beforeEach(async ({ page }) => { await login(page); });

test("named permanent confirmation cancels by keyboard without a request or navigation; responsive actions", async ({ page }) => {
  let posts = 0;
  page.on("request", request => { if (request.headers()["next-action"]) posts++; });
  let message = "";
  page.once("dialog", async dialog => { message = dialog.message(); await dialog.dismiss(); });
  const button = row(page, "cancel").getByRole("button", { name: label("cancel"), exact: true });
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(button).toBeFocused();
  expect(message).toContain(`Permanently delete bot “${names.cancel}”?`);
  expect(message).toContain("This cannot be undone");
  expect(message).toContain("routines, skills and memories");
  expect(posts).toBe(0);
  expect(await exists("cancel")).toBe(1);
  await expect(page).toHaveURL(/\/admin\/bots$/);
  if (process.env.BOT_DELETE_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.BOT_DELETE_SCREENSHOTS, "admin-bot-delete-desktop.png"), fullPage: true, animations: "disabled" });

  await page.setViewportSize({ width: 375, height: 812 });
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeInViewport();
  await expect(row(page, "cancel").getByRole("link", { name: "Edit", exact: true })).toBeInViewport();
  await expect(row(page, "cancel").getByRole("button", { name: "Disable", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const box = await button.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  page.once("dialog", dialog => dialog.dismiss());
  await button.click();
  expect(posts).toBe(0);
  if (process.env.BOT_DELETE_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.BOT_DELETE_SCREENSHOTS, "admin-bot-delete-mobile.png"), fullPage: true, animations: "disabled" });
});

test("pending locks duplicate submissions; a failed request preserves the row and permits retry/cancel", async ({ page }) => {
  let posts = 0;
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/admin/bots", async route => {
    if (!route.request().headers()["next-action"]) return route.continue();
    posts++;
    await hold;
    await route.abort("failed");
  });
  page.once("dialog", dialog => dialog.accept());
  await row(page, "retry").getByRole("button", { name: label("retry"), exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  const pending = row(page, "retry").getByRole("button", { name: `Deleting bot “${names.retry}”`, exact: true });
  await expect(pending).toBeDisabled();
  await expect(pending).toHaveAttribute("aria-busy", "true");
  await expect.poll(() => posts).toBe(1);
  release();
  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toBeVisible();
  const retry = row(page, "retry").getByRole("button", { name: label("retry"), exact: true });
  await expect(retry).toBeEnabled();
  expect(await exists("retry")).toBe(1);
  await expect(page).toHaveURL(/\/admin\/bots$/);
  page.once("dialog", dialog => dialog.dismiss());
  await retry.click();
  expect(posts).toBe(1);
  await page.unroute("**/admin/bots");
  page.once("dialog", dialog => dialog.accept());
  await retry.click();
  await expect(row(page, "retry")).toHaveCount(0);
  expect(await exists("retry")).toBe(0);
});

test("successful fixture deletion refreshes the list and keeps existing cascade semantics", async ({ page }) => {
  page.once("dialog", dialog => dialog.accept());
  await row(page, "success").getByRole("button", { name: label("success"), exact: true }).click();
  await expect(row(page, "success")).toHaveCount(0);
  await expect(page.locator('[data-sonner-toast][data-type="success"]')).toContainText(names.success);
  await expect(page).toHaveURL(/\/admin\/bots$/);
  expect(await exists("success")).toBe(0);
  expect((await pool.query("SELECT id FROM memories WHERE id=$1", [`${run}-memory`])).rowCount).toBe(0);
  expect((await pool.query("SELECT bot_id FROM conversations WHERE id=$1", [`${run}-conversation`])).rows[0].bot_id).toBeNull();
  expect(await exists("cancel")).toBe(1);
});

test("the existing native Hermes safeguard refuses deletion and shows an error", async ({ page }) => {
  page.once("dialog", dialog => dialog.accept());
  await row(page, "protected").getByRole("button", { name: label("protected"), exact: true }).click();
  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toBeVisible();
  await expect(row(page, "protected").getByRole("button", { name: label("protected"), exact: true })).toBeEnabled();
  expect(await exists("protected")).toBe(1);
  if (process.env.BOT_DELETE_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.BOT_DELETE_SCREENSHOTS, "admin-bot-delete-error.png"), fullPage: true, animations: "disabled" });
});

test("revoked admin access is checked again when confirming another owner's bot", async ({ page }) => {
  page.once("dialog", async dialog => {
    await pool.query("UPDATE users SET is_admin=false WHERE id=$1", [adminId]);
    await dialog.accept();
  });
  try {
    await row(page, "cancel").getByRole("button", { name: label("cancel"), exact: true }).click();
    await expect(page.locator('[data-sonner-toast][data-type="error"]')).toBeVisible();
    expect(await exists("cancel")).toBe(1);
    await page.goto("/admin/bots");
    await expect(page).toHaveURL(/\/$/);
  } finally { await pool.query("UPDATE users SET is_admin=true WHERE id=$1", [adminId]); }
});

test("the editor shares the named confirmation, cancel, and successful redirect", async ({ page }) => {
  await page.goto(`/bots/${botId("editor")}/edit`);
  const button = page.getByRole("button", { name: label("editor"), exact: true });
  page.once("dialog", async dialog => {
    expect(dialog.message()).toContain(`Permanently delete bot “${names.editor}”?`);
    await dialog.dismiss();
  });
  await button.click();
  expect(await exists("editor")).toBe(1);
  page.once("dialog", dialog => dialog.accept());
  await button.click();
  await expect(page).toHaveURL(/\/bots$/);
  expect(await exists("editor")).toBe(0);
});
