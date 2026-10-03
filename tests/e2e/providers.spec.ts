import { expect, test } from "@playwright/test";
import { login, send, choose } from "./helpers";

const MOCK = (process.env.MOCK_LLM_URL ?? "http://localhost:4010/v1").replace(/\/v1\/?$/, "");
const KEY = "sk-ant-api03-e2e-test-key";

test("admin adds a Claude app with a company key and people can chat with it", async ({ page }) => {
  await login(page, "alice");
  await page.goto("/admin/apps");
  await page.getByRole("button", { name: "Add app" }).click();
  const dialog = page.getByRole("dialog");
  const name = `E2E Claude ${Date.now()}`;
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await choose(page, dialog.getByLabel("Provider", { exact: true }), "anthropic");
  await dialog.getByLabel("Base URL", { exact: true }).fill(`${MOCK}/v1`);
  await dialog.getByLabel("API key", { exact: true }).fill(KEY);
  await dialog.getByLabel("Model", { exact: true }).fill("claude-sonnet-4-5");
  await dialog.getByLabel("Sort order", { exact: true }).fill("20");

  await dialog.getByRole("button", { name: /Test/ }).click();
  await expect(page.getByText("Connected — 3 model(s)")).toBeVisible();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("App saved")).toBeVisible();
  await expect(page.getByRole("cell", { name, exact: true })).toBeVisible();

  // Keys are write-only: never in the page, before or after a reload.
  expect(await page.content()).not.toContain(KEY);
  await page.reload();
  expect(await page.content()).not.toContain(KEY);

  await page.goto("/");
  await page.getByRole("button", { name: /Mock GPT/ }).click();
  await page.getByRole("menuitem", { name: new RegExp(name) }).click();
  await send(page, "Hello Claude");
  await expect(page.getByText('You said: "Hello Claude"').first()).toBeVisible();

  // The call lands in the usage ledger and the export.
  await expect
    .poll(async () => (await page.request.get("/api/admin/usage.csv")).text(), { timeout: 15_000 })
    .toContain(name);

  await page.goto("/admin/apps");
  page.once("dialog", (d) => d.accept());
  await page.getByLabel(`Delete ${name}`).click();
  await expect(page.getByRole("cell", { name, exact: true })).toHaveCount(0);
});
