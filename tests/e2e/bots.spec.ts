import { expect, test } from "@playwright/test";
import { login, openBot, send, choose } from "./helpers";

test("bot tool approval: deny, then allow", async ({ page }) => {
  await login(page, "alice");
  await openBot(page, "Research Assistant");
  await expect(page.locator("main header").getByRole("heading", { name: "Research Assistant", exact: true })).toBeVisible();
  // A bot now reopens its persistent home; isolate this test from earlier approval cards.
  await page.getByRole("button", { name: "Start side chat", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open home chat", exact: true })).toBeVisible();

  await send(page, '[tool:fetch_url {"url":"https://example.com"}]');
  await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible();
  await page.getByRole("button", { name: "Deny" }).click();
  await expect(page.getByText("Read page — denied")).toBeVisible();

  await send(page, '[tool:fetch_url {"url":"https://example.org"}]');
  await page.getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByText(/Read page( — failed)?$/).last()).toBeVisible();
});

test("memory tool saves a fact that later appears in settings", async ({ page }) => {
  await login(page, "alice");
  await openBot(page, "Research Assistant");
  await expect(page.locator("main header").getByRole("heading", { name: "Research Assistant", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start side chat", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open home chat", exact: true })).toBeVisible();
  await send(page, '[tool:remember {"fact":"Prefers bullet-point summaries"}]');
  await expect(page.getByText("Memory updated")).toBeVisible();
  await page.goto("/settings");
  await page.getByRole("button", { name: "Memory" }).click();
  await expect(page.getByText("Prefers bullet-point summaries").first()).toBeVisible();
});

test("routine run pauses for approval and resumes from the inbox", async ({ page }) => {
  await login(page, "alice");
  await openBot(page, "Research Assistant");
  await expect(page.locator("main header").getByRole("heading", { name: "Research Assistant", exact: true })).toBeVisible();

  // Grok-style side panel: create a routine with the friendly schedule picker, then "Test run".
  await page.getByRole("button", { name: "Show bot details" }).click();
  await page.getByLabel("New routine").click();
  const name = `E2E routine ${Date.now()}`;
  await page.getByPlaceholder("Morning inbox triage").fill(name);
  await page.locator('div[role="dialog"] textarea').fill('[tool:fetch_url {"url":"https://example.net"}]');
  await choose(page, page.getByLabel("Frequency"), "weekdays");
  await page.getByLabel("Time", { exact: true }).fill("08:15");
  await expect(page.getByText("Weekdays at 8:15 AM").first()).toBeVisible();
  await page.getByRole("button", { name: "Create routine" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  // The list refreshes right after saving; retry until the routine sheet is open.
  await expect(async () => {
    await page.getByText(name).click();
    await expect(page.getByRole("button", { name: "Test run" })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  await page.getByRole("button", { name: "Test run" }).click();
  await expect(page.getByText("Test run started")).toBeVisible();

  await expect(async () => {
    await page.goto("/inbox");
    await expect(page.getByText(`Routine "${name}" paused`)).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 45_000 });
  await page.locator("div.rounded-2xl", { hasText: `Routine "${name}" paused` }).getByRole("link", { name: "Review in chat" }).click();
  await page.getByRole("button", { name: "Allow once" }).click();
  await expect(async () => {
    await page.goto("/inbox");
    await expect(page.getByText(`${name} finished`)).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 45_000 });
});

test("duplicate a bot", async ({ page }) => {
  await login(page, "alice");
  await page.goto("/bots");
  await page.getByRole("link", { name: "Details" }).first().click();
  await page.getByRole("button", { name: "Duplicate" }).click();
  await page.waitForURL(/\/bots\/.+\/edit/);
  await expect(page.getByPlaceholder("Name your bot")).toHaveValue(/ copy$/);
});
