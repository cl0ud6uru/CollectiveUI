import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { choose, login } from "./helpers";

// Prerequisites: opt in with E2E_CHATGPT_SETUP=1 only on the disposable seeded E2E database with
// alice (admin), bob and carol accounts, the real local auth/LDAP service and worker, and the same
// CHATGPT_SIWC_HOST_ID configured for the app. This tests policy and local setup instructions only;
// it never imports a profile, signs in to OpenAI, or runs inference, so no ChatGPT endpoint override is used.
const enabled = process.env.E2E_CHATGPT_SETUP === "1";
test.skip(!enabled,
  "Set E2E_CHATGPT_SETUP=1 only for the seeded local app with its real database, LDAP, worker, and CHATGPT_SIWC_HOST_ID configured.");

test.afterAll(() => {
  if (!enabled) return;
  // The seed restores the default disabled policy and clears any test account credentials.
  execFileSync("npx", ["tsx", "--env-file=.env.local", "tests/e2e/seed-e2e.ts"], { stdio: "inherit" });
});

test("one unified ChatGPT account card shows disabled, allowed and unlisted setup states", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const chatgptRequests: string[] = [];
  page.on("request", request => {
    if (request.url().endsWith("/api/me/chatgpt") && request.method() === "POST") chatgptRequests.push(request.postData() ?? "");
  });

  // Before the admin enables the feature, the same account card is visible but cannot start setup.
  await login(page, "alice");
  await page.goto("/settings?tab=connected-accounts");
  const adminCard = page.locator("#chatgpt-account");
  await expect(adminCard.getByRole("heading", { name: "ChatGPT account", exact: true })).toBeVisible();
  await expect(adminCard.getByRole("status")).toContainText("ChatGPT connections are disabled");
  await expect(adminCard.getByRole("button", { name: /Set up ChatGPT|Continue ChatGPT setup/ })).toHaveCount(0);

  // Admin policy allows Bob, while admins retain access to their own setup controls.
  await page.goto("/admin/settings");
  await page.getByRole("switch", { name: "Enable Sign in with ChatGPT", exact: true }).click();
  await page.getByText("I understand that this uses each person's own subscription allowance and requires their explicit authorization.", { exact: true }).click();
  await choose(page, page.getByLabel("Who can connect", { exact: true }), "selected");
  await page.getByLabel("Allowed people", { exact: true }).fill("bob@corp.local");
  await page.getByRole("switch", { name: "Allow personal plans", exact: true }).click();
  await page.getByRole("button", { name: "Save ChatGPT settings", exact: true }).click();
  await expect(page.getByText("Saved")).toBeVisible();

  // Bob gets the supported local sign-in and protected import instructions. The browser does not
  // receive a device code, authorization URL, access token, refresh token, or profile import control.
  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  const bobChatgptRequests: string[] = [];
  bob.on("request", request => {
    if (request.url().endsWith("/api/me/chatgpt") && request.method() === "POST") bobChatgptRequests.push(request.postData() ?? "");
  });
  await login(bob, "bob");
  await bob.goto("/settings?tab=connected-accounts");
  const bobCard = bob.locator("#chatgpt-account");
  await expect(bobCard.getByRole("heading", { name: "ChatGPT account", exact: true })).toBeVisible();
  await expect(bobCard.getByRole("status")).toContainText("Connect once to use your ChatGPT account");
  await expect(bobCard.getByRole("button", { name: "Set up ChatGPT", exact: true })).toBeVisible();
  await expect(bobCard.getByRole("button", { name: "Connect ChatGPT", exact: true })).toHaveCount(0);
  const setupResponsePromise = bob.waitForResponse(response => response.url().endsWith("/api/me/chatgpt") && response.request().method() === "POST");
  await bob.getByRole("button", { name: "Set up ChatGPT", exact: true }).click();
  const setupResponse = await setupResponsePromise;
  expect(setupResponse.ok()).toBe(true);
  const setup = await setupResponse.json() as { hostId: string; userId: string };
  expect(setup.userId).toBeTruthy();
  await expect(bob.getByText("Finish ChatGPT setup", { exact: true })).toBeVisible();
  await expect(bob.getByText(/npm run chatgpt:sign-in -- --output/)).toBeVisible();
  await expect(bob.getByText(`npm run chatgpt:import -- --user-id ${setup.userId} --file /protected/path/chatgpt-profile.json`, { exact: true })).toBeVisible();
  await expect(bob.getByText(/Transfer only your selected profile over your own secure SSH connection/)).toBeVisible();
  await expect(bob.getByLabel("ChatGPT sign-in code")).toHaveCount(0);
  await expect(bob.getByRole("link", { name: /Open ChatGPT sign-in/i })).toHaveCount(0);
  expect(await bob.content()).not.toMatch(/accessToken|refreshToken|rt_mock_|MOCK-\d+|auth\.openai\.com/i);

  // An unlisted member sees why policy blocks setup; the card itself remains present.
  const carolContext = await browser.newContext();
  const carol = await carolContext.newPage();
  await login(carol, "carol");
  await carol.goto("/settings?tab=connected-accounts");
  const carolCard = carol.locator("#chatgpt-account");
  await expect(carolCard.getByRole("heading", { name: "ChatGPT account", exact: true })).toBeVisible();
  await expect(carolCard.getByRole("status")).toContainText("Your account is not enrolled");
  await expect(carolCard.getByRole("button", { name: /Set up ChatGPT|Continue ChatGPT setup/ })).toHaveCount(0);

  // The administrator is still allowed to use their own connection for administration.
  await page.goto("/settings?tab=connected-accounts");
  await expect(adminCard.getByRole("heading", { name: "ChatGPT account", exact: true })).toBeVisible();
  await expect(adminCard.getByRole("button", { name: "Set up ChatGPT", exact: true })).toBeVisible();
  await expect(adminCard.getByRole("status")).toContainText("Connect once to use your ChatGPT account");
  expect(chatgptRequests).toEqual([]);
  expect(bobChatgptRequests).toEqual([JSON.stringify({ action: "start" })]);
  expect(await page.content()).not.toMatch(/accessToken|refreshToken|rt_mock_|MOCK-\d+|auth\.openai\.com/i);

  await carolContext.close();
  await bobContext.close();
});
