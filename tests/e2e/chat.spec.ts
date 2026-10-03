import { expect, test } from "@playwright/test";
import { login, send } from "./helpers";

test("sign in with LDAP, chat with streaming, edit + branch, search", async ({ page }) => {
  await login(page, "bob");
  await send(page, "Hello there, please show a demo");
  await page.waitForURL(/\/c\//);
  await expect(page.getByText("Here's a quick demo")).toBeVisible();
  await expect(page.locator(".markdown table")).toBeVisible();
  await expect(page.getByText("Copy code")).toBeVisible();

  // Edit the question → creates a second branch
  const bubble = page.getByText("Hello there, please show a demo");
  await bubble.hover();
  await page.getByLabel("Edit message").click();
  await page.locator("textarea").first().fill("A different question");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText('You said: "A different question"')).toBeVisible();
  await expect(page.getByText("2/2").first()).toBeVisible();
  await page.getByLabel("Previous version").first().click();
  await expect(page.getByText("Here's a quick demo")).toBeVisible();

  // Search (Ctrl+K)
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder("Search chats and bots...").fill("different");
  await expect(page.locator('[role="dialog"] a').first()).toBeVisible();
});

test("group-restricted apps and admin pages are enforced", async ({ page, browser }) => {
  await login(page, "carol"); // no groups
  await page.getByRole("button", { name: /Mock GPT/ }).click();
  await expect(page.getByRole("menuitem", { name: /Engineering Copilot/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.goto("/admin");
  await expect(page).toHaveURL("/");
  const res = await page.request.post("/api/chat", {
    data: { conversationId: "abcdefgh12345678", appId: "does-not-exist", message: { id: "msgmsgmsg1", role: "user", parts: [{ type: "text", text: "x" }] } },
  });
  expect(res.status()).toBe(403);

  const bobCtx = await browser.newContext();
  const bob = await bobCtx.newPage();
  await login(bob, "bob"); // Engineering member
  await bob.getByRole("button", { name: /Mock GPT/ }).click();
  await expect(bob.getByRole("menuitem", { name: /Engineering Copilot/ })).toBeVisible();
  await bobCtx.close();
});

test("share a chat and continue it as another user", async ({ page, browser }) => {
  await login(page, "alice");
  await send(page, "Sharing test message");
  await expect(page.getByText('You said: "Sharing test message"')).toBeVisible();
  await page.getByLabel("Share chat").click();
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();
  const url = await page.locator('[role="dialog"] span.truncate').innerText();
  expect(url).toContain("/share/");

  const ctx = await browser.newContext();
  const bob = await ctx.newPage();
  await login(bob, "bob");
  await bob.goto(url);
  await expect(bob.getByText("Shared by Alice Admin")).toBeVisible();
  await bob.getByRole("button", { name: "Continue this conversation" }).click();
  await bob.waitForURL(/\/c\//);
  await expect(bob.getByText("Sharing test message").first()).toBeVisible();
  await ctx.close();
});
