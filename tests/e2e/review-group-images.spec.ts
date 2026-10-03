import { expect, test } from "@playwright/test";
import { login, send } from "./helpers";

test("group image upload reaches both vision bots across a handoff", async ({ page }) => {
  await login(page, "alice");
  await page.getByLabel("New group chat").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Research Assistant", { exact: true }).click();
  await dialog.getByText("Directory Bot", { exact: true }).click();
  await dialog.getByRole("button", { name: /Start group chat/ }).click();
  await page.waitForURL(/\/c\//);
  const uploaded = page.waitForResponse(response => response.url().endsWith("/api/files") && response.request().method() === "POST");
  await page.locator('input[type="file"]').setInputFiles({
    name: "synthetic-pixel.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSFAAAAAASUVORK5CYII=", "base64"),
  });
  expect((await uploaded).status()).toBe(200);
  await send(page, "Look at this image [handoff:Directory Bot]");
  await expect(page.getByText("On it — handing the details to @Directory Bot.", { exact: true })).toBeVisible();
  await expect(page.getByText(/I can see the image you attached/).first()).toBeVisible({ timeout: 30_000 });
});
