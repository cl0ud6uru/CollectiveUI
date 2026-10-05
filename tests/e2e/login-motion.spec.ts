import { expect, test } from "@playwright/test";

test("spotlight follows live motion and pointer preferences without a reload", async ({ page, context }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/login");
  const story = page.locator(".login-shell");
  const spotlight = page.locator(".login-spotlight");
  const move = async () => { await page.mouse.move(160, 260); await page.mouse.move(320, 340); };
  const expectStill = async () => {
    await expect(story).not.toHaveAttribute("data-pointer");
    await expect(spotlight).toHaveCSS("opacity", "0");
    expect(await story.evaluate(el => el.style.getPropertyValue("--mx"))).toBe("");
    expect(await story.evaluate(el => el.style.getPropertyValue("--my"))).toBe("");
  };
  await move(); await expectStill();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await move(); await expect(story).toHaveAttribute("data-pointer", "on");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expectStill(); await move(); await expectStill();
  expect(await page.evaluate(() => document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations === Infinity).length)).toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await move(); await expect(story).toHaveAttribute("data-pointer", "on");
  await page.emulateMedia({ forcedColors: "active" });
  await expectStill(); await expect(spotlight).toHaveCSS("display", "none");
  await page.emulateMedia({ forcedColors: "none" });
  await move(); await expect(story).toHaveAttribute("data-pointer", "on");
  await page.setViewportSize({ width: 390, height: 844 });
  await expectStill();
  await page.setViewportSize({ width: 1360, height: 900 });
  await move(); await expect(story).toHaveAttribute("data-pointer", "on");
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await expect.poll(() => page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
  await expectStill(); await move(); await expectStill();
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  // Headless Chromium falls back to pointer:none after removing its emulated touchscreen.
  await expect.poll(() => page.evaluate(() => matchMedia("(pointer: none)").matches)).toBe(true);
  await move(); await expectStill();
  await cdp.detach();
});

test("mobile keeps the still avatar family and visible sign-in controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/login");
  await expect(page.locator(".bot-constellation-stage .blob")).toHaveCount(7);
  expect(await page.evaluate(() => document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations === Infinity).length)).toBe(0);
  // Freeze the first entrance frame: form controls must never rely on the animation to become visible.
  await page.evaluate(() => document.getAnimations().forEach(a => { a.pause(); a.currentTime = 0; }));
  await expect(page.getByLabel("Company username")).toBeVisible();
  await expect(page.locator(".login-form-wrap > .space-y-4")).toHaveCSS("opacity", "1");
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Continue", exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeInViewport();
  }
});

test("keyboard, forced colors and server-rendered login remain usable", async ({ page, browser }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
  await page.goto("/login");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to sign in" })).toBeFocused();
  await page.keyboard.press("Enter"); await page.keyboard.press("Tab");
  await expect(page.getByLabel("Company username")).toBeFocused();
  await expect(page.getByLabel("Company username")).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Tab"); await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
  await page.keyboard.press("Tab"); await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeFocused();
  await expect(page.locator(".login-word").first()).toHaveCSS("background-image", "none");
  expect(await page.locator(".login-word").first().evaluate(el => getComputedStyle(el).color)).not.toBe("rgba(0, 0, 0, 0)");
  const text = await page.locator("h1").textContent();
  const noScript = await browser.newContext({ javaScriptEnabled: false, reducedMotion: "reduce" });
  try {
    const ssr = await noScript.newPage(); await ssr.goto(page.url());
    await expect(ssr.locator("h1")).toHaveText(text!);
    await expect(ssr.getByLabel("Company username")).toBeVisible();
    await expect(ssr.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
  } finally { await noScript.close(); }
  expect(errors).toEqual([]);
});

test("successful login removes spotlight listeners from the detached story", async ({ page, context }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/login");
  const cdp = await context.newCDPSession(page);
  const { result } = await cdp.send("Runtime.evaluate", { expression: "document.querySelector('.login-shell')" });
  const listeners = async () => (await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId! })).listeners.map(l => l.type);
  // Navigation can finish before React attaches the effect's listeners.
  await expect.poll(listeners).toEqual(expect.arrayContaining(["pointermove", "pointerleave"]));
  await page.mouse.move(200, 250);
  await expect(page.locator(".login-shell")).toHaveAttribute("data-pointer", "on");
  await page.getByLabel("Company username").fill("alice");
  await page.getByLabel("Password", { exact: true }).fill("Passw0rd!");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForURL("/");
  await expect.poll(listeners).toEqual([]);
  await cdp.detach();
});
