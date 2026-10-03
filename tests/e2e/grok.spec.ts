import { expect, test } from "@playwright/test";
import { login, send } from "./helpers";

test("group chat: lead answers, @mentions route, bots hand off visibly", async ({ page }) => {
  await login(page, "alice");
  await page.getByLabel("New group chat").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Research Assistant", { exact: true }).click();
  await dialog.getByText("Directory Bot", { exact: true }).click();
  await dialog.getByPlaceholder("Group name (optional)").fill(`Launch crew ${Date.now()}`);
  await dialog.getByRole("button", { name: /Start group chat/ }).click();
  await page.waitForURL(/\/c\//);
  await expect(page.getByText("picks up anything that isn't addressed")).toBeVisible();

  // Un-addressed → the lead answers, and hands off to Directory Bot with an @mention.
  await send(page, "Plan the launch [handoff:Directory Bot]");
  await expect(page.getByText("On it — handing the details to @Directory Bot.", { exact: true })).toBeVisible();
  const reply = page.locator(".group").filter({ hasText: "handing the details" }).last();
  await expect(reply.getByText("Research Assistant", { exact: true })).toBeVisible();
  await expect(reply.getByText("Directory Bot", { exact: true }).first()).toBeVisible();

  // @mention picker, then only the mentioned bot replies.
  await page.getByLabel("Message", { exact: true }).fill("@Dir");
  await page.getByRole("button", { name: "@Directory Bot" }).click();
  await page.getByLabel("Message", { exact: true }).pressSequentially("who owns payments?");
  await page.keyboard.press("Enter");
  await expect(page.getByText('You said: "@Directory Bot who owns payments?"').first()).toBeVisible();
});

test("pin, hide and unhide a bot in the sidebar", async ({ page }) => {
  await login(page, "alice");
  const nav = page.locator("nav");
  await nav.getByLabel("Directory Bot options").click();
  await page.getByRole("menuitem", { name: "Hide from sidebar" }).click();
  await expect(page.getByText("hidden — its routines keep running")).toBeVisible();
  await nav.getByRole("button", { name: /Hidden Bots/ }).click();
  await nav.getByRole("button", { name: "Unhide" }).first().click();
  await expect(nav.getByLabel("Directory Bot options")).toBeVisible();

  await nav.getByLabel("Directory Bot options").click();
  await page.getByRole("menuitem", { name: "Pin to top" }).click();
  await expect(nav.locator("a", { hasText: "Directory Bot" }).first().locator("svg.lucide-pin")).toBeVisible();
  await nav.getByLabel("Directory Bot options").click();
  await page.getByRole("menuitem", { name: "Unpin" }).click();
});

test("share a bot as a template link and add it as another user", async ({ page, browser }) => {
  await login(page, "alice");
  await page.goto("/bots");
  // Exact name: "duplicate a bot" (bots.spec) may have created a "Directory Bot copy" with the same description.
  await page.locator("div.group").filter({ has: page.getByText("Directory Bot", { exact: true }) }).getByRole("link", { name: "Details" }).click();
  await page.getByRole("button", { name: "Share template" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: /Create template|Copy link/ })).toBeVisible();
  const create = dialog.getByRole("button", { name: "Create template" });
  if (await create.isVisible()) await create.click();
  await expect(dialog.getByRole("button", { name: "Copy link" })).toBeVisible();
  const url = await dialog.locator("span.truncate").first().innerText();
  expect(url).toContain("/templates/");

  const ctx = await browser.newContext();
  const bob = await ctx.newPage();
  await login(bob, "bob");
  await bob.goto(url);
  await expect(bob.getByText("Shared by Alice Admin")).toBeVisible();
  await bob.getByRole("button", { name: "Add to my bots" }).click();
  await bob.waitForURL(/\/bots\/.+\/edit/);
  await expect(bob.getByPlaceholder("Name your bot")).toHaveValue("Directory Bot");
  await ctx.close();
});
