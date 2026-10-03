import { Pool } from "pg";
import { expect, type Locator, type Page } from "@playwright/test";

export async function login(page: Page, username: string, password = "Passw0rd!") {
  // Regression suites perform many synthetic logins; opt-in reset is restricted to the disposable fixture DB.
  if (process.env.E2E_RESET_AUTH_THROTTLE === "1") {
    if (!/\/(collective_local_browser_test|collective_pets_test|collective_pets_visual_test)$/.test(process.env.DATABASE_URL ?? "")) throw new Error("Throttle reset requires a disposable browser fixture database");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try { await pool.query("DELETE FROM auth_throttle"); } finally { await pool.end(); }
  }
  await page.goto("/login");
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL("/");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
}

export async function send(page: Page, text: string) {
  const box = page.getByLabel("Message", { exact: true });
  await box.fill(text);
  // The send button only exists (and is enabled) once any previous reply has finished streaming.
  await expect(page.getByLabel("Send message")).toBeEnabled({ timeout: 30_000 });
  await box.press("Enter");
}

/** Open a direct chat with a bot by exact name (via the Bots page, independent of sidebar order). */
export async function openBot(page: Page, name: string) {
  await page.goto("/bots");
  await page.getByRole("link", { name: `Chat with ${name}`, exact: true }).first().click();
  await page.waitForURL(/\/c\/[A-Za-z0-9]+$/);
}

/** Pick an option in the app's dropdown (`components/ui/select`), the way a person would: open it, click the value. */
export async function choose(page: Page, field: Locator, value: string) {
  await field.click();
  await page.locator(`[role="option"][data-value="${value}"]`).click();
  await expect(page.locator('[role="listbox"]')).toHaveCount(0);
}
