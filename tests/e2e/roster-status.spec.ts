import { expect, test } from "@playwright/test";
import { login, openBot, send } from "./helpers";

// The sidebar's status is per bot: an idle chat must not hide another chat of the same bot that waits for approval.
test("a side chat waiting for approval keeps the bot marked while its idle home is open", async ({ page }) => {
  await login(page, "alice");
  await openBot(page, "Research Assistant");
  const homeUrl = page.url();
  const row = page.locator("nav a", { hasText: "Research Assistant" }).first();

  await page.getByRole("button", { name: "Start side chat", exact: true }).click();
  await page.waitForURL((url) => url.href !== homeUrl);
  await send(page, '[tool:fetch_url {"url":"https://example.com/roster"}]');
  await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible({ timeout: 30_000 });
  const sideUrl = page.url();
  await expect(row).toContainText("Needs your approval");

  await row.click();
  await page.waitForURL(homeUrl);
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await expect(row).toContainText("Needs your approval");

  // Leave nothing pending for other suites.
  await page.goto(sideUrl);
  await page.getByRole("button", { name: "Deny" }).click();
  await expect(page.getByRole("button", { name: "Allow once" })).toHaveCount(0, { timeout: 30_000 });
});
