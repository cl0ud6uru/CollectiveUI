import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { login, send, choose } from "./helpers";

// Needs the app started with CHATGPT_AUTH_BASE_URL / CHATGPT_BACKEND_URL pointing at mock-llm (README → tests);
// otherwise "Connect ChatGPT" would go to the real auth.openai.com, so the test is skipped.
const envLocal = (() => {
  try {
    return readFileSync(".env.local", "utf8");
  } catch {
    return "";
  }
})();
const pointsAtMock = !!process.env.CHATGPT_AUTH_BASE_URL || /^CHATGPT_AUTH_BASE_URL=\S+/m.test(envLocal);
test.skip(!pointsAtMock, "Set CHATGPT_AUTH_BASE_URL and CHATGPT_BACKEND_URL to mock-llm for the app under test (README → Running the tests)");

// Leave the feature off and nobody connected even if the test fails midway (the seed resets both).
test.afterAll(() => {
  execFileSync("npx", ["tsx", "--env-file=.env.local", "tests/e2e/seed-e2e.ts"], { stdio: "inherit" });
});

test("admin turns on Sign in with ChatGPT; an allowed person connects their plan and chats on it", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const name = `E2E ChatGPT ${Date.now()}`;

  // Admin: turn it on for bob only, allowing personal plans (the mock signs people in on a Plus plan).
  await login(page, "alice");
  await page.goto("/admin/settings");
  await page.getByLabel("Enable Sign in with ChatGPT", { exact: true }).click();
  await page.getByText("I understand this is unofficial").click();
  await page.getByLabel("Allowed people", { exact: true }).fill("bob@corp.local");
  await page.getByLabel("Allow personal plans", { exact: true }).click();
  await page.getByRole("button", { name: "Save ChatGPT settings" }).click();
  await expect(page.getByText("Saved")).toBeVisible();

  // Admin: add a ChatGPT plan app (no credentials to enter).
  await page.goto("/admin/apps");
  await page.getByRole("button", { name: "Add app" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await choose(page, dialog.getByLabel("Provider", { exact: true }), "chatgpt");
  await expect(dialog.getByText("Unofficial.", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("API key", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Temperature", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "List my plan's models" }).click();
  await expect(page.getByText(/Connect your own ChatGPT account/)).toBeVisible(); // alice hasn't connected
  await dialog.getByLabel("Model", { exact: true }).fill("mock-codex");
  await dialog.getByLabel("Sort order", { exact: true }).fill("30");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("App saved")).toBeVisible();
  await expect(page.getByRole("cell", { name, exact: true })).toBeVisible();

  // bob: sees the app with the plan badge, connects with a device code, then chats on his plan.
  const bobCtx = await browser.newContext();
  const bob = await bobCtx.newPage();
  await login(bob, "bob");
  await bob.getByRole("button", { name: /Mock GPT/ }).click();
  const item = bob.getByRole("menuitem", { name: new RegExp(name) });
  await expect(item).toContainText("Your ChatGPT plan · unofficial");
  await expect(item).toContainText("Connect in Settings first");
  await bob.getByRole("menuitem", { name: "Connect your ChatGPT plan…" }).click();
  await bob.waitForURL(/\/settings\?tab=connected-accounts/);
  await bob.getByRole("button", { name: "Connect ChatGPT" }).click();
  await expect(bob.getByLabel("ChatGPT sign-in code")).toHaveText(/^MOCK-\d+$/);
  await expect(bob.getByText("Connected", { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(bob.getByText(/Plus · workspace/)).toBeVisible();
  expect(await bob.content()).not.toContain("rt_mock_"); // tokens never reach the browser

  await bob.goto("/");
  await bob.getByRole("button", { name: /Mock GPT/ }).click();
  await bob.getByRole("menuitem", { name: new RegExp(name) }).click();
  await send(bob, "Hello from my plan");
  await expect(bob.getByText('You said: "Hello from my plan"').first()).toBeVisible();

  // A limit reached on the plan is explained, with no retry storm.
  await send(bob, "[limit] one more");
  await expect(bob.getByRole("main").getByText(/reached your ChatGPT plan's usage limit/)).toBeVisible();

  // carol isn't allowed: the app isn't offered.
  const carolCtx = await browser.newContext();
  const carol = await carolCtx.newPage();
  await login(carol, "carol");
  await carol.getByRole("button", { name: /Mock GPT/ }).click();
  await expect(carol.getByRole("menuitem", { name: new RegExp(name) })).toHaveCount(0);
  await carolCtx.close();

  // bob disconnects.
  await bob.goto("/settings?tab=connected-accounts");
  bob.once("dialog", (d) => d.accept());
  await bob.getByRole("button", { name: "Disconnect" }).click();
  await expect(bob.getByRole("button", { name: "Connect ChatGPT" })).toBeVisible();
  await bobCtx.close();

  // Admin: clean up.
  await page.goto("/admin/apps");
  page.once("dialog", (d) => d.accept());
  await page.getByLabel(`Delete ${name}`).click();
  await expect(page.getByRole("cell", { name, exact: true })).toHaveCount(0);
  await page.goto("/admin/settings");
  await page.getByLabel("Enable Sign in with ChatGPT", { exact: true }).click();
  await page.getByRole("button", { name: "Save ChatGPT settings" }).click();
  await expect(page.getByText("Saved")).toBeVisible();
});
