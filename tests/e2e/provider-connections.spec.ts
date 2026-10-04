import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { hashPassword } from "../../src/lib/auth/password";
import { choose } from "./helpers";

test.skip(process.env.PROVIDERS_BROWSER_TEST !== "1", "Disposable synthetic installation required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const password = "Synthetic-provider-browser!42";
async function login(page: Page, role: string) {
  await page.goto("/login");
  await page.getByLabel("Local username or email").fill(`providers-${role}`);
  await page.getByLabel("Local password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in with local account" }).click();
  await page.waitForURL("/");
}
test.beforeAll(async () => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/collective_providers_test") throw new Error("Disposable provider fixture database required");
  const hash = await hashPassword(password);
  await pool.query("DELETE FROM ai_apps");
  await pool.query("DELETE FROM provider_connections");
  await pool.query("DELETE FROM users WHERE id IN ('providers-admin','providers-member')");
  for (const role of ["admin", "member"]) {
    await pool.query("INSERT INTO users(id,upn,name,identity_realm,auth_source,is_admin) VALUES($1,$2,$3,'local','local',$4)", [`providers-${role}`, `local:providers-${role}`, `Providers ${role}`, role === "admin"]);
    await pool.query("INSERT INTO local_credentials(user_id,username,password_hash,must_change_password) VALUES($1,$1,$2,false)", [`providers-${role}`, hash]);
    await pool.query("INSERT INTO local_login_aliases(login,user_id) VALUES($1,$1)", [`providers-${role}`]);
  }
  await pool.query("DELETE FROM auth_throttle");
});
test.afterAll(async () => { await pool.end(); });

test("named credential reuse, empty edit fields, dependency impact, cancel and repeat flows", async ({ page }) => {
  await login(page, "admin");
  await page.goto("/admin/apps");
  await page.getByRole("button", { name: "Add provider connection", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Connection name", { exact: true }).fill("Canceled credential");
  await dialog.getByLabel("Provider API key", { exact: true }).fill("fixture-never-saved");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await pool.query("SELECT id FROM provider_connections")).rowCount).toBe(0);
  await page.getByRole("button", { name: "Add provider connection", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Provider API key", { exact: true })).toHaveValue("");
  await dialog.getByLabel("Connection name", { exact: true }).fill("Engineering fixture");
  await dialog.getByLabel("Provider organization", { exact: true }).fill("org-fixture");
  await dialog.getByLabel("Provider project", { exact: true }).fill("proj-fixture");
  await dialog.getByLabel("Provider API key", { exact: true }).fill("fixture-provider-browser-one");
  await dialog.getByRole("button", { name: "Save provider connection", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const connection = (await pool.query("SELECT * FROM provider_connections")).rows[0];
  expect(connection.secret_enc).not.toContain("fixture-provider-browser-one");
  expect(connection.created_by).toBe("providers-admin");
  expect(await page.content()).not.toContain("fixture-provider-browser-one");
  for (const [name, model] of [["Model Alpha", "fixture-alpha"], ["Model Beta", "fixture-beta"]]) {
    await page.getByRole("button", { name: "Add model connection", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name", { exact: true }).fill(name);
    await choose(page, dialog.getByLabel("Model provider", { exact: true }), "openai");
    await choose(page, dialog.getByLabel("Saved provider connection", { exact: true }), connection.id);
    await expect(dialog.getByLabel("Base URL", { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel("Organization ID", { exact: true })).toHaveValue("org-fixture");
    await expect(dialog.getByLabel("Project ID", { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel("API key", { exact: true })).toHaveCount(0);
    await dialog.getByLabel("Model", { exact: true }).fill(model);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  const models = (await pool.query("SELECT provider_connection_id,api_key_enc FROM ai_apps")).rows;
  expect(models).toEqual([{ provider_connection_id: connection.id, api_key_enc: null }, { provider_connection_id: connection.id, api_key_enc: null }]);
  const section = page.getByRole("region", { name: "Saved provider credentials" });
  await expect(section.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
  await section.getByRole("button", { name: "Engineering fixture", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Provider API key", { exact: true })).toHaveValue("");
  await expect(dialog.getByLabel("Affected models")).toContainText("Model Alpha");
  await expect(dialog.getByLabel("Affected models")).toContainText("Model Beta");
  await dialog.getByLabel("Provider API key", { exact: true }).fill("fixture-provider-browser-two");
  page.once("dialog", d => d.dismiss());
  await dialog.getByRole("button", { name: "Save provider connection", exact: true }).click();
  expect((await pool.query("SELECT secret_enc FROM provider_connections")).rows[0].secret_enc).toBe(connection.secret_enc);
  page.once("dialog", d => d.accept());
  await dialog.getByRole("button", { name: "Save provider connection", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await pool.query("SELECT secret_enc FROM provider_connections")).rows[0].secret_enc).not.toBe(connection.secret_enc);
  await page.screenshot({ path: "/tmp/collective-providers-browser.png", fullPage: true });
  await section.getByRole("button", { name: "Engineering fixture", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Provider API key", { exact: true })).toHaveValue("");
  expect(await page.content()).not.toContain("fixture-provider-browser-two");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("model audience does not grant provider administration", async ({ page }) => {
  await login(page, "member");
  await page.goto("/admin/apps");
  await expect(page).toHaveURL("/");
  await expect(page.getByText("Saved provider credentials", { exact: true })).toHaveCount(0);
  expect(await page.content()).not.toMatch(/fixture-provider-browser|org-fixture|proj-fixture/);
});
