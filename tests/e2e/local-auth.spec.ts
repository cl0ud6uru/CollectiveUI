import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { mkdir } from "node:fs/promises";

test.skip(process.env.LOCAL_AUTH_BROWSER !== "1", "Uses its own disposable local-auth fixture installation");
const password = "Synthetic-browser-fixture!42";
const temporary = "Synthetic-temporary-fixture!43";
const replacement = "Synthetic-private-fixture!44";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const output = "/tmp/collective-local-screenshots";
async function localLogin(page: Page, username: string, secret: string) {
  await page.goto("/login");
  await page.getByLabel("Local username or email").fill(username);
  await page.getByLabel("Local password", { exact: true }).fill(secret);
  await page.getByRole("button", { name: "Sign in with local account" }).click();
}
test.beforeAll(async () => {
  if (!process.env.DATABASE_URL?.endsWith("/collective_local_browser_test")) throw new Error("Disposable local browser database required");
  const { createLocalUser } = await import("../../src/lib/auth/local");
  const { pool: appPool } = await import("../../src/db");
  process.env.LOCAL_AUTH_OPERATOR = "bootstrap";
  await pool.query("DELETE FROM users WHERE identity_realm='local'");
  await pool.query("DELETE FROM local_auth_bootstrap");
  await createLocalUser({ username: "fixture-admin", email: "fixture-admin@example.invalid", name: "Fixture Administrator", password }, "bootstrap");
  delete process.env.LOCAL_AUTH_OPERATOR;
  await appPool.end();
  await mkdir(output, { recursive: true });
});
test.beforeEach(async () => { await pool.query("DELETE FROM auth_throttle"); });
test.afterAll(async () => { await pool.end(); });

test("local-only login preserves branding, generic errors, responsive layout and CSRF", async ({ page, request }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Microsoft" })).toHaveCount(0);
  await expect(page.getByLabel("Company username")).toHaveCount(0);
  await page.screenshot({ path: `${output}/local-login-desktop.png`, fullPage: true });
  await localLogin(page, "unknown", "wrong");
  const generic = "Unable to sign in. Check your credentials or try again later.";
  await expect(page.locator("form[aria-label='Local account']").getByRole("alert")).toHaveText(generic);
  await localLogin(page, "fixture-admin", "wrong");
  await expect(page.locator("form[aria-label='Local account']").getByRole("alert")).toHaveText(generic);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await page.screenshot({ path: `${output}/local-login-mobile.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // Missing double-submit CSRF token never creates a session, even with valid credentials.
  await request.post("/api/auth/callback/local", { form: { username: "fixture-admin", password }, maxRedirects: 0 });
  expect(await (await request.get("/api/auth/session")).json()).toBeNull();
  expect((await request.get("/api/chat")).status()).toBe(401);
});

test("admin creates user; temporary login is restricted; password change, ownership, reset and revocation work", async ({ page, browser }) => {
  await localLogin(page, "FIXTURE-ADMIN@example.invalid", password);
  await expect(page).toHaveURL("/");
  const sessionCookie = (await page.context().cookies()).find(c => c.name.includes("session-token"));
  expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: "Lax" });
  await page.goto("/admin/users");
  await page.getByText("Create local account", { exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill("fixture-member");
  await page.getByLabel("Display name").fill("Fixture Member");
  await page.getByLabel("Email (optional login alias)").fill("fixture-member@example.invalid");
  await page.getByLabel("Temporary password", { exact: true }).fill(temporary);
  const mutation = page.waitForRequest(r => r.method() === "POST" && new URL(r.url()).pathname === "/admin/users");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Account created");
  const actionRequest = await mutation;
  const originalHeaders = await actionRequest.allHeaders();
  const actionHeaders = { "content-type": originalHeaders["content-type"], "next-action": originalHeaders["next-action"] };
  for (const origin of [undefined, "https://evil.example"]) {
    const rejected = await page.request.post(actionRequest.url(), { headers: { ...actionHeaders, ...(origin ? { origin } : {}) }, data: actionRequest.postDataBuffer()!, maxRedirects: 0 });
    expect(rejected.status()).toBeGreaterThanOrEqual(400);
  }
  await page.reload();
  await page.screenshot({ path: `${output}/local-admin-users.png`, fullPage: true });
  const context = await browser.newContext(); const member = await context.newPage();
  try {
    await localLogin(member, "fixture-member@example.invalid", temporary);
    await expect(member).toHaveURL("/account/password");
    expect((await member.request.get("/api/search?q=anything")).status()).toBe(403);
    await member.goto("/admin/users"); await expect(member).toHaveURL("/account/password");
    await member.screenshot({ path: `${output}/local-password-change.png`, fullPage: true });
    await member.getByLabel("Current or temporary password").fill(temporary);
    await member.getByLabel("New password", { exact: true }).fill(replacement);
    await member.getByLabel("Confirm new password").fill(replacement);
    await member.getByRole("button", { name: "Change password and sign out" }).click();
    await expect(member).toHaveURL("/login");
    await localLogin(member, "fixture-member", replacement); await expect(member).toHaveURL("/");
    await member.goto("/admin/users"); await expect(member).toHaveURL("/");
    await member.goto("/settings"); await expect(member.getByRole("link", { name: "Change local password" })).toBeVisible();
    const [admin] = (await pool.query("SELECT id FROM users WHERE upn='local:fixture-admin'")).rows;
    await pool.query("INSERT INTO conversations(id,user_id,title) VALUES ('fixturePrivateChat',$1,'Private admin chat')", [admin.id]);
    await member.goto("/c/fixturePrivateChat");
    await expect(member.getByText("Private admin chat", { exact: true })).toHaveCount(0);
    await page.goto("/admin/users");
    const row = page.getByRole("row").filter({ hasText: "Fixture Member" });
    await row.getByText("Reset local password", { exact: true }).click();
    await row.getByLabel("New temporary password").fill(temporary);
    await row.getByRole("button", { name: "Reset password", exact: true }).click();
    await expect(row.getByRole("status")).toContainText("Sessions revoked");
    await member.goto("/settings"); await expect(member).toHaveURL(/\/login/);
    await localLogin(member, "fixture-member", replacement); await expect(member.locator("form[aria-label='Local account']").getByRole("alert")).toBeVisible();
    await localLogin(member, "fixture-member", temporary); await expect(member).toHaveURL("/account/password");
    await row.getByRole("button", { name: "User actions" }).click();
    await page.getByRole("menuitem", { name: "Disable user", exact: true }).click();
    // The menu starts an async action; wait for its refreshed row before testing the revoked session.
    await expect(row.getByText("disabled", { exact: true })).toBeVisible();
    await member.goto("/account/password"); await expect(member).toHaveURL(/\/login/);
  } finally { await context.close(); }
});
