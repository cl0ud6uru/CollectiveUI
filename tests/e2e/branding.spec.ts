import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { login } from "./helpers";

const endpoint = "/api/admin/branding/logo";
const headers = { origin: process.env.BASE_URL ?? "http://localhost:3000", "content-type": "image/png" };

// Serial: branding is installation-wide. Restore defaults even if an assertion fails.
test("admin branding lifecycle, public logo safety, responsive login and accessible controls", async ({ page, browser, request }) => {
  test.setTimeout(120_000);
  const guest = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
  const visitor = await guest.newPage();
  const user = await browser.newContext();
  const member = await user.newPage();
  const png = await sharp({ create: { width: 80, height: 80, channels: 4, background: "#8575d6" } }).png().toBuffer();
  const jpeg = await sharp({ create: { width: 120, height: 60, channels: 3, background: "#b8f6e5" } }).jpeg().toBuffer();
  await login(page, "alice");
  await page.goto("/admin/settings");
  const fields = ["Portal name", "Chat welcome text", "Sign-in headline", "Sign-in introduction"];
  const original = await Promise.all(fields.map((label) => page.getByLabel(label, { exact: true }).inputValue()));
  const previousLogoResponse = await request.get("/api/branding/logo");
  const previousLogo = previousLogoResponse.ok() ? await previousLogoResponse.body() : null;
  await page.request.delete(endpoint, { headers });
  await page.reload();
  try {
    expect((await request.post(endpoint, { headers, data: png })).status()).toBe(401);
    expect((await request.delete(endpoint, { headers })).status()).toBe(401);
    await login(member, "bob");
    expect((await user.request.post(endpoint, { headers, data: png })).status()).toBe(403);
    expect((await user.request.delete(endpoint, { headers })).status()).toBe(403);
    await member.goto("/admin/settings");
    await expect(member).toHaveURL("/");
    expect((await page.request.post(endpoint, { headers: { ...headers, origin: "https://evil.example" }, data: png })).status()).toBe(403);
    expect((await page.request.delete(endpoint, { headers: { ...headers, origin: "https://evil.example" } })).status()).toBe(403);
    expect((await page.request.post(endpoint, { headers, data: Buffer.alloc(2 * 1024 * 1024 + 1) })).status()).toBe(413);
    for (const data of [Buffer.from("<svg><script>alert(1)</script></svg>"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])]) {
      expect((await page.request.post(endpoint, { headers, data })).status()).toBeGreaterThanOrEqual(400);
    }
    await page.getByLabel("Portal name", { exact: true }).fill("Collective Studio");
    await page.getByLabel("Sign-in headline").fill("A little help. A bigger possibility.");
    await page.getByLabel("Sign-in introduction").fill("Bring your team and your bots together in one thoughtful workspace.");
    await page.getByRole("button", { name: "Save branding" }).click();
    await expect(page.getByRole("status")).toHaveText("Branding saved.");
    // Native file chooser is reachable with the keyboard.
    await expect(page.getByRole("button", { name: "Upload logo", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Upload logo", exact: true }).focus();
    await expect(page.getByRole("button", { name: "Upload logo", exact: true })).toBeFocused();
    const chooser = page.waitForEvent("filechooser", { timeout: 10_000 });
    await page.keyboard.press("Enter");
    await (await chooser).setFiles({ name: "brand.png", mimeType: "image/png", buffer: png });
    await expect(page.getByRole("status")).toContainText("Logo saved");
    await expect(page.getByRole("button", { name: "Replace logo" })).toBeVisible();
    const first = page.locator('img[src^="/api/branding/logo"]');
    const firstUrl = await first.getAttribute("src");
    const publicLogo = await request.get(firstUrl!);
    expect(publicLogo.status()).toBe(200);
    expect(publicLogo.headers()["content-type"]).toBe("image/png");
    expect(publicLogo.headers()["cache-control"]).toBe("no-store");
    expect(publicLogo.headers()["x-content-type-options"]).toBe("nosniff");
    const extra = await request.get("/api/branding/logo?key=../../private-settings&v=anything");
    expect(await extra.body()).toEqual(await publicLogo.body());
    expect((await request.get("/api/admin/branding/logo")).status()).toBe(401);
    await visitor.goto("/login");
    await expect(visitor).toHaveTitle("Collective Studio");
    await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("A little help. A bigger possibility.");
    await expect(visitor.locator('img[src^="/api/branding/logo"]')).toHaveJSProperty("naturalWidth", 80);
    await expect(visitor.locator(".bot-main")).toHaveCSS("animation-name", "none");
    await visitor.keyboard.press("Tab");
    await expect(visitor.getByRole("link", { name: "Skip to sign in" })).toBeFocused();
    await visitor.keyboard.press("Enter");
    await visitor.keyboard.press("Tab");
    await expect(visitor.getByLabel("Company username")).toBeFocused();
    await visitor.keyboard.press("Tab");
    await expect(visitor.getByLabel("Password", { exact: true })).toBeFocused();
    await visitor.keyboard.press("Tab");
    await expect(visitor.getByRole("button", { name: "Continue", exact: true })).toBeFocused();
    await visitor.getByLabel("Company username").fill("alice");
    await visitor.getByLabel("Password", { exact: true }).fill("incorrect");
    await visitor.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(visitor.locator(".login-form-wrap").getByRole("alert")).toHaveText("Incorrect username or password.");
    await visitor.goto("/login");
    for (const width of [320, 390, 768, 1440]) {
      await visitor.setViewportSize({ width, height: 844 });
      expect(await visitor.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await visitor.getByLabel("Password", { exact: true }).scrollIntoViewIfNeeded();
      await expect(visitor.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
    }
    await page.getByLabel("Organization logo", { exact: true }).setInputFiles({ name: "replacement.jpg", mimeType: "image/jpeg", buffer: jpeg });
    await expect(first).not.toHaveAttribute("src", firstUrl!);
    await visitor.reload();
    await expect(visitor.locator('img[src^="/api/branding/logo"]')).toHaveJSProperty("naturalWidth", 120);
    // Missing file: the UI keeps the fallback mark and usable form.
    await visitor.route("**/api/branding/logo?*", (route) => route.fulfill({ status: 404 }));
    await visitor.reload();
    await expect(visitor.locator('img[src^="/api/branding/logo"]')).toHaveCount(0);
    await expect(visitor.locator(".login-brand > span[aria-hidden]")).toBeVisible();
    await visitor.unroute("**/api/branding/logo?*");
    await page.goto("/");
    await expect(page.locator('img[src^="/api/branding/logo"]').first()).toHaveJSProperty("naturalWidth", 120);
    await page.goto("/login?preview=1");
    await expect(page.getByRole("status")).toContainText("Admin preview");
    await page.goto("/login?callbackUrl=https://evil.example");
    await expect(page).toHaveURL("/");
    await page.goto("/admin/settings");
    await page.getByRole("button", { name: "Remove logo" }).click();
    await expect(page.getByRole("status")).toContainText("Logo removed");
    expect((await request.get(firstUrl!)).status()).toBe(404);
    await visitor.reload();
    await expect(visitor.locator('img[src^="/api/branding/logo"]')).toHaveCount(0);
    await expect(visitor.locator(".login-brand > span[aria-hidden]")).toBeVisible();
    await visitor.goto("/login?callbackUrl=/bots");
    await visitor.getByLabel("Company username").fill("bob");
    await visitor.getByLabel("Password", { exact: true }).fill("Passw0rd!");
    await visitor.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(visitor).toHaveURL("/bots");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel("Portal name", { exact: true }).fill("W".repeat(60));
    await page.getByRole("button", { name: "Save branding" }).click();
    await expect(page.getByRole("status")).toHaveText("Branding saved.");
    await expect(page.getByRole("button", { name: "Save branding" })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    test.setTimeout(150_000); // Keep cleanup time available after an assertion timeout.
    await page.request.delete(endpoint, { headers });
    if (previousLogo) await page.request.post(endpoint, { headers, data: previousLogo });
    await page.goto("/admin/settings");
    for (const [i, label] of fields.entries()) await page.getByLabel(label, { exact: true }).fill(original[i]);
    await page.getByRole("button", { name: "Save branding" }).click();
    await expect(page.getByRole("status")).toHaveText("Branding saved.");
    await guest.close();
    await user.close();
  }
});
