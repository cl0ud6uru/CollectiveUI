import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import sharp from "sharp";
import { hashPassword } from "../../src/lib/auth/password";
import { send } from "./helpers";

test.skip(process.env.CHAT_HEADER_BROWSER !== "1", "Requires a disposable local installation and mock LLM worker");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const password = "Synthetic-header!42";
const bot = "headerHermes";
const longName = "A very long bot name for a thoughtful research and planning companion ".repeat(3);
const avatar = (page: Page, id = bot) => page.locator(`header [data-bot-avatar="${id}"]`);
const detailsToggle = (page: Page) => page.locator("main header").getByRole("button", { name: /^(Show|Hide) bot details$/ });
const detailsPanel = (page: Page) => page.getByRole("complementary", { name: "Hermes activity and outputs" });

test.beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/collective_header_test") throw new Error("Disposable header fixture database required");
  await pool.query("DELETE FROM users WHERE id='headerViewer'");
  await pool.query("DELETE FROM ai_apps WHERE id='headerModel'");
  await pool.query("DELETE FROM auth_throttle");
  await pool.query("INSERT INTO users(id,upn,name,identity_realm,auth_source) VALUES ('headerViewer','local:headerViewer','Alex','local','local')");
  await pool.query("INSERT INTO local_credentials(user_id,username,password_hash,must_change_password) VALUES ('headerViewer','header-viewer',$1,false)", [await hashPassword(password)]);
  await pool.query("INSERT INTO local_login_aliases(login,user_id) VALUES ('header-viewer','headerViewer')");
  await pool.query("INSERT INTO ai_apps(id,name,provider,model,base_url,is_public,supports_tools) VALUES ('headerModel','Mock GPT','openai-compatible','mock-gpt',$1,true,true)", [process.env.MOCK_LLM_URL ?? "http://localhost:4020/v1"]);
  for (const [id, name, icon] of [[bot, "Hermes", "🛰️"], ["headerLong", longName, "blob:circle:teal"], ["headerEmoji", "Navigator", "🧭"], ["headerMoss", "Studio Companion", null], ["headerCatalog", "Catalog Companion", null]]) {
    await pool.query("INSERT INTO bots(id,owner_id,name,avatar,app_id,visibility,description,label) VALUES ($1,'headerViewer',$2,$3,'headerModel','private','A little help with your next idea.','Personal assistant')", [id, name, icon]);
    await pool.query("INSERT INTO user_bot_prefs(user_id,bot_id,pinned) VALUES ('headerViewer',$1,true)", [id]);
  }
  // Original geometric fixture: catalog rendering must not depend on bundled artwork.
  const sprite = await sharp({ create: { width: 1536, height: 2288, channels: 4, background: "#66aa88" } }).png().toBuffer();
  const manifest = { displayName: "Header Sprout", description: "Synthetic fixture", spriteVersionNumber: 2, credit: "CollectiveUI test fixture · MIT" };
  await pool.query("INSERT INTO pet_catalog(id,manifest,sprite,revision,status) VALUES ('header-fixture',$1,$2,'header-fixture-v1','published') ON CONFLICT (id) DO UPDATE SET manifest=EXCLUDED.manifest,sprite=EXCLUDED.sprite,status='published'", [JSON.stringify(manifest), sprite]);
  await pool.query("INSERT INTO bot_pet_defaults(bot_id,appearance,catalog_id) VALUES ($1,'catalog','header-fixture'),('headerCatalog','catalog','header-fixture'),('headerMoss','moss',null)", [bot]);
  await pool.query("INSERT INTO bot_tools(bot_id,tool_key,approval) VALUES ($1,'fetch_url','ask')", [bot]);
  await pool.query("INSERT INTO conversations(id,user_id,bot_id,title,is_bot_home) VALUES ('headerHome','headerViewer',$1,'Ideas with Hermes',true)", [bot]);
  await pool.query("INSERT INTO messages(id,conversation_id,role,parts) VALUES ('headerQuestion','headerHome','user',$1)", [JSON.stringify([{ type: "text", text: "Help me plan a focused morning." }])]);
  await pool.query("INSERT INTO messages(id,conversation_id,parent_id,role,parts) VALUES ('headerAnswer','headerHome','headerQuestion','assistant',$1)", [JSON.stringify([{ type: "text", text: "Start with one meaningful task, give it an uninterrupted hour, then take a short break. What would you like to work on first?" }])]);
  await pool.query("UPDATE conversations SET current_leaf_id='headerAnswer' WHERE id='headerHome'");
  await pool.query("INSERT INTO conversations(id,user_id,bot_id,title) VALUES ('headerScroll','headerViewer',$1,'Scroll regression')", [bot]);
  await pool.query("INSERT INTO messages(id,conversation_id,role,parts) VALUES ('headerScrollQuestion','headerScroll','user',$1)", [JSON.stringify([{ type: "text", text: "Keep the first message clear of the header." }])]);
  const transcript = "## Scroll regression notes\n\n[Read these notes](https://example.com/header-notes)\n\n" + Array.from({ length: 30 }, (_, i) => `### Step ${i + 1}\n\nChoose one useful task, keep your notes nearby, and leave enough room to change direction. A quiet hour makes the next decision easier.`).join("\n\n");
  await pool.query("INSERT INTO messages(id,conversation_id,parent_id,role,parts) VALUES ('headerScrollAnswer','headerScroll','headerScrollQuestion','assistant',$1)", [JSON.stringify([{ type: "text", text: transcript }])]);
  await pool.query("UPDATE conversations SET current_leaf_id='headerScrollAnswer' WHERE id='headerScroll'");
});
test.afterAll(async () => { await pool.end(); });
test.beforeEach(async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Local username or email").fill("header-viewer");
  await page.getByLabel("Local password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in with local account" }).click();
  await page.waitForURL("/");
  await page.goto(`/?bot=${bot}`);
  // The saved-chat snapshot and sprite routes may compile on first entry in dev.
  await expect(avatar(page).locator("img")).toHaveJSProperty("naturalHeight", 2288, { timeout: 30_000 });
});

async function geometry(page: Page, id = bot) {
  const header = page.locator("main header");
  // Read in one browser frame: the sidebar animates its width during viewport changes.
  const { pet, pane, name, controls } = await header.evaluate((el, botId) => ({
    pet: el.querySelector(`[data-bot-avatar="${botId}"]`)!.getBoundingClientRect().toJSON(),
    pane: el.getBoundingClientRect().toJSON(),
    name: el.querySelector("h1")!.getBoundingClientRect().toJSON(),
    controls: Array.from(el.querySelectorAll("button, a")).filter(control => control.getClientRects().length).map(control => ({
      box: control.getBoundingClientRect().toJSON(), label: control.getAttribute("aria-label"),
    })),
  }), id);
  expect(Math.abs(pet.x + pet.width / 2 - (pane.x + pane.width / 2))).toBeLessThan(1);
  expect(pet.width).toBeCloseTo(pane.width >= 576 ? 84 : 64);
  // A normal desktop pane puts the pet at the top, alongside the controls.
  if (pane.width >= 800) expect(pet.y - pane.y).toBeCloseTo(8);
  // Narrow panes stack controls above the pet; allow the 44px details touch target.
  expect(pane.height).toBeLessThan(200);
  expect(name.y).toBeGreaterThanOrEqual(pet.y + pet.height);
  for (const control of await header.locator("button:visible, a:visible").all()) {
    await expect(control).toBeInViewport();
  }
  for (const { box, label } of controls) {
    for (const content of [pet, name]) {
      const overlap = Math.min(box.x + box.width, content.x + content.width) - Math.max(box.x, content.x) > 1 && Math.min(box.y + box.height, content.y + content.height) - Math.max(box.y, content.y) > 1;
      expect(overlap, `Control ${label} overlaps bot identity`).toBe(false);
    }
  }
  await expect(page.getByLabel("Message", { exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByText(/^Home chat · Return here/)).toHaveCount(0);
}

test("centered in the pane across themes, sidebars, viewport widths and empty chats", async ({ page }, info) => {
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => { localStorage.setItem("theme", theme); }, theme);
    await page.reload();
    await expect(page.locator("html")).toHaveClass(new RegExp(theme));
    await detailsToggle(page).click();
    await geometry(page);
    await page.screenshot({ path: info.outputPath(`desktop-${theme}.png`) });
    await detailsToggle(page).click();
    await geometry(page);
    await page.getByRole("button", { name: "Close sidebar", exact: true }).click();
    await expect.poll(async () => (await page.locator("main").boundingBox())?.x).toBe(52);
    await geometry(page);
    await page.screenshot({ path: info.outputPath(`desktop-collapsed-${theme}.png`) });
    await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
    await detailsToggle(page).click();
    for (const width of [1024, 900, 768, 390, 320]) {
      await page.setViewportSize({ width, height: width < 400 ? 568 : 900 });
      await geometry(page);
    }
    await page.screenshot({ path: info.outputPath(`mobile-${theme}.png`) });
    await page.getByRole("button", { name: "Start side chat", exact: true }).click();
    await expect(page).not.toHaveURL(/headerHome$/);
    await geometry(page);
    await expect(page.locator("main h1")).toHaveCount(1);
    await page.screenshot({ path: info.outputPath(`mobile-empty-${theme}.png`) });
    await page.getByRole("link", { name: "Open home chat", exact: true }).click();
    await expect(page).toHaveURL(/headerHome$/);
    await page.setViewportSize({ width: 1360, height: 900 });
  }
});

test("long names, pet variants, non-pet fallbacks and reduced motion", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(avatar(page).locator("img")).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(avatar(page).locator("img")).toHaveCSS("animation-name", "pet-frames");
  for (const id of ["headerLong", "headerEmoji", "headerMoss", "headerCatalog"]) {
    await page.goto(`/?bot=${id}`);
    await expect(avatar(page, id)).toBeVisible();
    for (const width of [1360, 800, 390, 320]) {
      await page.setViewportSize({ width, height: width < 400 ? 568 : 900 });
      await geometry(page, id);
    }
    if (id === "headerLong") {
      await expect(page.locator("header h1")).toHaveAttribute("title", longName);
      expect(await page.locator("header h1").evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath("mobile-long-name.png") });
    }
    if (id === "headerLong" || id === "headerEmoji") await expect(avatar(page, id)).toHaveAttribute("data-pet-enabled", "false");
    else await expect(avatar(page, id)).toHaveAttribute("data-pet-enabled", "true");
    await page.emulateMedia({ reducedMotion: "reduce" });
    if (id === "headerMoss") await expect(avatar(page, id).locator(".pet-body")).toHaveCSS("animation-name", "none");
    if (id === "headerCatalog") await expect(avatar(page, id).locator("img")).toHaveCSS("animation-name", "none");
  }
});

test("actions, keyboard access, activity and home history retain their behavior", async ({ page }, info) => {
  const home = page.url();
  await page.getByRole("button", { name: "Share chat" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Share link to chat" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Share chat" })).toBeFocused();
  await page.getByRole("button", { name: "Start side chat", exact: true }).click();
  await expect(page).not.toHaveURL(home);
  const side = page.url();
  await send(page, "A focused side conversation");
  await expect(page.getByText('You said: "A focused side conversation"', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(avatar(page)).toHaveAttribute("data-activity", "idle");
  await page.getByRole("link", { name: "Open home chat", exact: true }).click();
  await expect(page).toHaveURL(home);
  await expect(page.getByText("Help me plan a focused morning.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Bot chat history" }).click();
  await page.locator(`[role="menuitem"][href="${new URL(side).pathname}"]`).click();
  await expect(page).toHaveURL(side);
  await send(page, "[slow] Keep working on this thought for a moment.");
  await expect(avatar(page)).toHaveAttribute("data-activity", "working");
  await detailsToggle(page).click();
  await detailsToggle(page).click();
  await expect(page).toHaveURL(side);
  await expect(avatar(page)).toHaveAttribute("data-activity", "working");
  await page.getByLabel("Stop generating").click();
  await expect(avatar(page)).not.toHaveAttribute("data-activity", "working");
  await expect.poll(async () => (await pool.query("SELECT count(*)::int AS n FROM agent_runs WHERE status IN ('queued','running')")).rows[0].n).toBe(0);
  await send(page, '[tool:fetch_url {"url":"https://example.com/header"}]');
  await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible();
  await expect(avatar(page)).toHaveAttribute("data-activity", "approval");
  await expect(page.locator("header")).toContainText("Needs your approval");
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(avatar(page)).toHaveAttribute("data-activity", "idle", { timeout: 30_000 });
  // A saved workspace tool result exposes the existing workspace action without running a sandbox.
  const cid = new URL(side).pathname.split("/").at(-1);
  const leaf = (await pool.query("SELECT current_leaf_id FROM conversations WHERE id=$1", [cid])).rows[0].current_leaf_id;
  await pool.query("INSERT INTO messages(id,conversation_id,parent_id,role,parts) VALUES ('headerWorkspace',$1,$2,'assistant',$3)", [cid, leaf, JSON.stringify([{ type: "tool-workspace_list", toolCallId: "header-tool", state: "output-available", input: {}, output: { files: [] } }])]);
  await pool.query("UPDATE conversations SET current_leaf_id='headerWorkspace' WHERE id=$1", [cid]);
  await page.reload();
  await expect(detailsToggle(page)).toHaveAttribute("aria-expanded", "false");
  for (const width of [1360, 1092, 1060, 1028, 1024, 800, 390, 320]) {
    await page.setViewportSize({ width, height: width < 400 ? 568 : 900 });
    await geometry(page);
  }
  await page.getByRole("button", { name: "Hermes's workspace", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Hermes activity" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Hermes activity" })).toHaveCount(0);
  await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
  await page.locator(`nav a[href="/?bot=${bot}"]:visible`).click();
  await expect(page).toHaveURL(home);
  await expect(page.getByRole("button", { name: "Close sidebar", exact: true })).toBeHidden();
  await geometry(page);
  await page.screenshot({ path: info.outputPath("mobile-home-restored.png") });
  expect((await pool.query("SELECT count(*)::int AS n FROM conversations WHERE bot_id=$1 AND is_bot_home", [bot])).rows[0].n).toBe(1);
});

test("bot details start collapsed and stay visit-local across navigation and reload", async ({ page }) => {
  const toggle = detailsToggle(page);
  const composer = page.getByLabel("Message", { exact: true });
  const draft = "Keep this unsent thought while I inspect the bot.";
  const home = page.url();
  await expect(toggle).toHaveAccessibleName("Show bot details");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(detailsPanel(page)).toHaveCount(0);
  expect(await toggle.evaluate(el => document.getElementById(el.getAttribute("aria-controls")!)?.hidden)).toBe(true);
  await composer.fill(draft);
  for (let attempt = 0; attempt < 2; attempt++) {
    await toggle.focus();
    await expect(toggle).toHaveCSS("outline-style", "solid");
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAccessibleName("Hide bot details");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(detailsPanel(page)).toBeVisible();
    expect(await toggle.evaluate(el => !!document.getElementById(el.getAttribute("aria-controls")!)?.querySelector("aside"))).toBe(true);
    // Radix dismisses a tooltip on activation until the pointer leaves/re-enters.
    await page.mouse.move(0, 0);
    await toggle.hover();
    await expect(page.getByRole("tooltip", { name: "Hide bot details" })).toBeVisible();
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAccessibleName("Show bot details");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toBeFocused();
    await expect(detailsPanel(page)).toHaveCount(0);
    await expect(composer).toHaveValue(draft);
    await expect(page.getByText("Help me plan a focused morning.", { exact: true })).toBeVisible();
  }
  await toggle.click();
  await detailsPanel(page).getByRole("button", { name: "Hide bot details" }).click();
  await expect(toggle).toBeFocused();
  await expect(composer).toHaveValue(draft);
  await toggle.click();
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(detailsPanel(page)).toHaveCount(0);
  await toggle.click();
  await page.getByRole("button", { name: "Start side chat", exact: true }).click();
  await expect(page).not.toHaveURL(home);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await page.getByRole("link", { name: "Open home chat", exact: true }).click();
  await expect(page).toHaveURL(home);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(detailsPanel(page)).toHaveCount(0);
  await page.goBack();
  await expect(page).not.toHaveURL(home);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("bot details support mobile dismissal, touch targets and safe focus on layout changes", async ({ page }) => {
  const toggle = detailsToggle(page);
  const composer = page.getByLabel("Message", { exact: true });
  const draft = "My mobile draft stays here.";
  await composer.fill(draft);
  for (const width of [768, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toBeInViewport();
    const box = (await toggle.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await toggle.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Hermes activity" });
    await expect(dialog).toBeVisible();
    // The background is inert while the dialog is open; inspect its persistent control directly.
    const headerToggle = page.locator("main header button[aria-controls]");
    await expect(headerToggle).toHaveAttribute("aria-expanded", "true");
    expect(await headerToggle.evaluate(el => !!document.getElementById(el.getAttribute("aria-controls")!)?.closest('[role="dialog"]'))).toBe(true);
    const close = dialog.getByRole("button", { name: "Hide bot details" });
    await expect(close).toBeInViewport();
    const closeBox = (await close.boundingBox())!;
    expect(closeBox.width).toBeGreaterThanOrEqual(44);
    expect(closeBox.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(composer).toHaveValue(draft);
    await toggle.click();
    await expect(dialog).toBeVisible();
    // Escape must dismiss immediately, even before moving focus off the close control.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await toggle.click();
    await dialog.getByRole("button", { name: "Hide bot details" }).click();
    await expect(toggle).toBeFocused();
    await expect(composer).toHaveValue(draft);
    await geometry(page);
  }
  await page.setViewportSize({ width: 1360, height: 900 });
  await toggle.click();
  await detailsPanel(page).getByRole("button", { name: "Hide bot details" }).focus();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
  await expect(detailsPanel(page)).toHaveCount(0);
  await toggle.click();
  await expect(page.getByRole("dialog", { name: "Hermes activity" })).toBeVisible();
  await page.setViewportSize({ width: 1360, height: 900 });
  await expect(page.getByRole("dialog", { name: "Hermes activity" })).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
  await expect(composer).toHaveValue(draft);
  // Nested dialogs render in portals but still belong to the closing details panel.
  await toggle.click();
  await detailsPanel(page).getByRole("button", { name: "New routine" }).click();
  await page.getByPlaceholder("Morning inbox triage").fill("Unsent routine");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await expect(composer).toHaveValue(draft);
  // Resizing must not steal focus from a user who has returned to the composer.
  await page.setViewportSize({ width: 1360, height: 900 });
  await toggle.click();
  await detailsPanel(page).getByRole("button", { name: "Hide bot details" }).focus();
  await composer.focus();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue(draft);
});

test("long transcripts scroll beneath the header without losing first messages or hit targets", async ({ page }) => {
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => localStorage.setItem("theme", theme), theme);
    for (const width of [1360, 1920, 390, 320]) {
      await page.setViewportSize({ width, height: width < 400 ? 844 : 900 });
      await page.goto("/c/headerScroll");
      await expect(page.locator("html")).toHaveClass(new RegExp(theme));
      const first = page.getByText("Keep the first message clear of the header.", { exact: true });
      const scroll = page.locator("main .overflow-y-auto").filter({ has: first });
      const header = page.locator("main header");
      await expect(first).toBeAttached({ timeout: 30_000 });
      await scroll.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
      await geometry(page);
      const headerBox = (await header.boundingBox())!;
      expect((await scroll.boundingBox())!.y).toBeCloseTo(headerBox.y);
      expect((await first.boundingBox())!.y).toBeGreaterThan(headerBox.y + headerBox.height);
      await expect(first).toBeInViewport();

      // Place a real message link inside the fade, away from the solid identity.
      const link = page.getByRole("link", { name: "Read these notes", exact: true });
      const linkBox = (await link.boundingBox())!;
      await scroll.evaluate((el, top) => { el.scrollTop = top; el.dispatchEvent(new Event("scroll")); }, linkBox.y - headerBox.y - headerBox.height + 30);
      await expect.poll(async () => (await link.boundingBox())!.y).toBeLessThan(headerBox.y + headerBox.height);
      expect(await link.evaluate(el => {
        const box = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(box.x + 3, box.y + box.height / 2));
      })).toBe(true);
      const fadedBox = (await link.boundingBox())!;
      const beforeWheel = await scroll.evaluate(el => el.scrollTop);
      await page.mouse.move(fadedBox.x + 3, fadedBox.y + fadedBox.height / 2);
      await page.mouse.wheel(0, 240);
      await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(beforeWheel);
      expect((await header.boundingBox())!.y).toBe(headerBox.y);
      expect((await header.boundingBox())!.height).toBe(headerBox.height);

      // Focus must bring a previously scrolled-out link below the overlay.
      await link.focus();
      await expect(link).toBeFocused();
      expect((await link.boundingBox())!.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height);
      for (const control of await header.locator("button:visible, a:visible").all()) {
        expect(await control.evaluate(el => {
          const box = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        })).toBe(true);
      }
      await page.getByRole("button", { name: "Bot chat history" }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Share chat" }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog", { name: "Share link to chat" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "Share chat" })).toBeFocused();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(avatar(page).locator("img")).toHaveCSS("animation-name", "none");
      await expect(avatar(page)).toHaveCSS("opacity", "1");
      await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event("scroll")); });
      await expect(page.getByRole("heading", { name: "Step 30", exact: true })).toBeInViewport();
      await expect(page.getByLabel("Message", { exact: true })).toBeInViewport();
    }
  }
});

test("short chats retain their spacing while the pane and text size change", async ({ page }) => {
  const first = page.getByText("Help me plan a focused morning.", { exact: true });
  const scroll = page.locator("main .overflow-y-auto").filter({ has: first });
  for (const width of [1360, 1920, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const fontSize of [16, 20]) {
      await page.locator("html").evaluate((el, size) => { el.style.fontSize = `${size}px`; }, fontSize);
      await expect.poll(async () => {
        const header = (await page.locator("main header").boundingBox())!;
        return (await first.boundingBox())!.y - header.y - header.height;
      }).toBeGreaterThan(0);
      await expect(first).toBeInViewport();
      expect(await scroll.evaluate(el => el.scrollTop)).toBe(0);
      expect((await scroll.boundingBox())!.y).toBe(0);
      await expect(page.getByLabel("Message", { exact: true })).toBeInViewport();
    }
  }
});
