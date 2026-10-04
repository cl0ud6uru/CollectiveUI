import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import sharp from "sharp";
import { choose, login, openBot, send } from "./helpers";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const botId = `petE2E${Date.now()}`;
const botName = `Studio Partner ${botId.slice(-6)}`;
let ownerId: string;
const endpoint = `/api/bots/${botId}/pet`;
const spriteUrl = `${endpoint}/sprite`;
const origin = new URL(process.env.BASE_URL ?? "http://localhost:3000").origin;
const pref = { mode: "personal", appearance: "moss", catalogId: null, motion: "auto" };

test.beforeAll(async () => {
  ownerId = (await pool.query("SELECT id FROM users WHERE upn='alice@corp.local'")).rows[0].id;
  const app = (await pool.query("SELECT id FROM ai_apps WHERE name='Mock GPT'")).rows[0].id;
  await pool.query("INSERT INTO bots (id,owner_id,name,app_id,visibility,description) VALUES ($1,$2,$3,$4,'private','A thoughtful space for ideas, plans and small discoveries.')", [botId, ownerId, botName, app]);
  await pool.query("INSERT INTO user_bot_prefs (user_id,bot_id,pinned) VALUES ($1,$2,true)", [ownerId, botId]);
  await pool.query("INSERT INTO bot_tools (bot_id,tool_key,approval) VALUES ($1,'fetch_url','ask')", [botId]);
});
test.beforeEach(async () => {
  await pool.query("DELETE FROM conversations WHERE bot_id=$1", [botId]);
  await pool.query("DELETE FROM bot_pets WHERE bot_id=$1", [botId]);
});
test.afterAll(async () => {
  await pool.query("DELETE FROM conversations WHERE bot_id=$1", [botId]);
  await pool.query("DELETE FROM bots WHERE id=$1", [botId]);
  await pool.end();
});

const avatar = (page: Page) => page.locator(`header [data-bot-avatar="${botId}"]`).first();
const activity = (page: Page) => page.getByRole("status", { name: "Bot avatar activity" });
const settings = (page: Page) => page.getByRole("button", { name: `Pet avatar settings for ${botName}`, exact: true });
const toggle = (page: Page) => page.getByRole("radio", { name: "Personal pet", exact: true });
async function preferences(page: Page) {
  await expect.poll(async () => await settings(page).isVisible() || await page.getByRole("button", { name: "Show bot details" }).isVisible()).toBe(true);
  if (!await settings(page).isVisible()) await page.getByRole("button", { name: "Show bot details" }).click();
  await settings(page).click();
  await expect(toggle(page)).toBeEnabled();
}
async function enable(page: Page) {
  await preferences(page);
  await toggle(page).focus(); await page.keyboard.press("Space");
  await expect(toggle(page)).toBeChecked();
  await expect(toggle(page)).toBeEnabled();
  await page.keyboard.press("Escape");
}

test("private avatar replaces existing icons; keyboard preferences persist and restore original icons", async ({ page }) => {
  await login(page, "alice"); await openBot(page, botName);
  await page.getByRole("button", { name: "Show bot details" }).click();
  const header = avatar(page);
  await expect(header).toHaveAttribute("data-pet-enabled", "false");
  const original = await header.innerHTML();
  const headerBox = await header.boundingBox();
  expect(headerBox?.width).toBeCloseTo(84);
  expect((await page.locator(`nav [data-bot-avatar="${botId}"]`).boundingBox())?.width).toBe(32);
  expect((await page.locator(`aside [data-bot-avatar="${botId}"]`).last().boundingBox())?.width).toBe(56);
  await expect(page.getByTestId("bot-companion")).toHaveCount(0);
  await enable(page);
  await expect(settings(page)).toBeFocused();
  for (const place of [header, page.locator(`nav [data-bot-avatar="${botId}"]`), page.locator(`aside [data-bot-avatar="${botId}"]`).last()]) {
    await expect(place).toHaveAttribute("data-pet-enabled", "true");
    await expect(place.locator(".pet-seedling")).toBeVisible();
  }
  expect(await header.boundingBox()).toEqual(headerBox);
  await preferences(page);
  await page.getByRole("radio", { name: "Ember", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Ember", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Ember", exact: true })).toBeEnabled();
  await choose(page, page.getByLabel("Animation", { exact: true }), "still");
  await expect(page.getByRole("status").filter({ hasText: "Preferences saved." })).toBeVisible();
  await page.keyboard.press("Escape"); await page.reload();
  await expect(header).toHaveAttribute("data-pet-appearance", "ember");
  await expect(header.locator(".pet-body")).toHaveCSS("animation-name", "none");
  await openBot(page, "Directory Bot");
  const inactive = page.locator(`nav [data-bot-avatar="${botId}"]`);
  await expect(inactive).toHaveAttribute("data-activity", "decorative");
  await expect(inactive).not.toHaveAttribute("title");
  await expect(activity(page)).toHaveCount(0);
  await openBot(page, botName); await page.getByRole("button", { name: "Start side chat", exact: true }).click();
  await expect(header).toHaveAttribute("data-pet-appearance", "ember");
  await page.goto(`/bots/${botId}`);
  await expect(page.locator(`main [data-bot-avatar="${botId}"]`)).toHaveAttribute("data-pet-appearance", "ember");
  await expect(page.locator(`main [data-bot-avatar="${botId}"]`)).toHaveAttribute("data-activity", "decorative");
  await page.goto("/bots");
  await expect(page.getByRole("link", { name: `Chat with ${botName}`, exact: true }).locator("[data-bot-avatar]")).toHaveAttribute("data-pet-appearance", "ember");
  await openBot(page, botName); await preferences(page); await page.getByRole("radio", { name: "Off · original icon", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Off · original icon", exact: true })).toBeChecked();
  await expect(toggle(page)).toBeEnabled(); await page.keyboard.press("Escape"); await page.reload();
  await expect(header).toHaveAttribute("data-pet-enabled", "false");
  expect(await header.innerHTML()).toBe(original);
  expect(await (await page.request.get(endpoint)).json()).toMatchObject({ enabled: false, preference: { mode: "off", appearance: "ember", motion: "still" } });
  expect((await pool.query("SELECT avatar FROM bots WHERE id=$1", [botId])).rows[0].avatar).toBeNull();
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() === "PATCH") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Fixture: saving unavailable." }) });
    else await route.continue();
  });
  await preferences(page); await toggle(page).click();
  await expect(page.getByRole("alert")).toContainText("saving unavailable");
  await expect(toggle(page)).not.toBeChecked();
  await expect(header).toHaveAttribute("data-pet-enabled", "false");
});

test("group speakers keep separate private pets and historical replies stay decorative", async ({ page }) => {
  const secondId = `${botId}second`;
  const secondName = "Pet Group Partner";
  let groupId: string | undefined;
  try {
    const app = (await pool.query("SELECT app_id FROM bots WHERE id=$1", [botId])).rows[0].app_id;
    await pool.query("INSERT INTO bots(id,owner_id,name,app_id,visibility) VALUES($1,$2,$3,$4,'private')", [secondId, ownerId, secondName, app]);
    await pool.query("INSERT INTO bot_pets(user_id,bot_id,enabled,mode,appearance) VALUES($1,$2,true,'personal','moss'),($1,$3,true,'personal','ember')", [ownerId, botId, secondId]);
    await login(page, "alice");
    await page.getByLabel("New group chat").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText(botName, { exact: true }).click();
    await dialog.getByText(secondName, { exact: true }).click();
    await dialog.getByRole("button", { name: /Start group chat/ }).click();
    await page.waitForURL(/\/c\//); groupId = page.url().split("/c/")[1];
    await send(page, `Introduce the team [handoff:${secondName}]`);
    await expect(page.getByLabel("Stop generating")).toHaveCount(0, { timeout: 30_000 });
    // Speaker markers sit next to message bubbles; header/member icons are deliberately excluded.
    const first = page.locator(`main [data-bot-avatar="${botId}"].mb-0\\.5`);
    const second = page.locator(`main [data-bot-avatar="${secondId}"].mb-0\\.5`);
    await expect(first).toHaveAttribute("data-pet-appearance", "moss");
    await expect(second).toHaveAttribute("data-pet-appearance", "ember");
    await send(page, `@${secondName} [slow] Give a thoughtful follow up with a few useful details for the team.`);
    await expect(second.last()).toHaveAttribute("data-activity", "working");
    await expect(first).toHaveAttribute("data-activity", "decorative");
    await expect(second.first()).toHaveAttribute("data-activity", "decorative");
    await page.getByLabel("Stop generating").click();
    await expect.poll(async () => (await pool.query("SELECT count(*)::int AS n FROM agent_runs WHERE conversation_id=$1 AND status IN ('queued','running')", [groupId])).rows[0].n).toBe(0);
    await page.reload();
    await expect(first).toHaveAttribute("data-pet-appearance", "moss");
    await expect(second.first()).toHaveAttribute("data-pet-appearance", "ember");
  } finally {
    if (groupId) await pool.query("DELETE FROM conversations WHERE id=$1", [groupId]);
    await pool.query("DELETE FROM bots WHERE id=$1", [secondId]);
  }
});

test("real stream, stop, approval and persisted failure states; offline is explicit", async ({ page, context }) => {
  await login(page, "alice"); await openBot(page, botName); await enable(page);
  const pet = activity(page);
  await expect(pet).toContainText("Idle in this chat");
  await send(page, "[slow] Help me think through a small creative project.");
  await expect(pet).toContainText("Working in this chat");
  await expect(avatar(page)).toHaveAttribute("data-activity", "working");
  await expect(page.locator(`nav [data-bot-avatar="${botId}"]`)).toHaveAttribute("data-activity", "working");
  const activeConversation = page.url().split("/c/")[1];
  await expect.poll(async () => (await pool.query("SELECT status FROM agent_runs WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 1", [activeConversation])).rows[0]?.status).toBe("running");
  await page.reload(); await expect(pet).toContainText("Working in this chat");
  await page.getByLabel("Stop generating").click();
  await expect(pet).not.toContainText("Working in this chat");
  // Stop closes the client stream before the durable worker acknowledges cancellation.
  await expect.poll(async () => (await pool.query("SELECT status FROM agent_runs WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 1", [activeConversation])).rows[0]?.status).toBe("cancelled");
  await send(page, '[tool:fetch_url {"url":"https://example.com/pet-approval"}]');
  await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible();
  await expect(pet).toContainText("Waiting for your approval");
  await page.reload(); await expect(pet).toContainText("Waiting for your approval");
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(pet).toContainText("Idle in this chat", { timeout: 30_000 });
  await context.setOffline(true); await expect(pet).toContainText("Chat connection unavailable");
  await context.setOffline(false); await expect(pet).toContainText("Idle in this chat");
  const conversationId = page.url().split("/c/")[1];
  const id = `petError${Date.now()}`;
  const leaf = (await pool.query("SELECT current_leaf_id FROM conversations WHERE id=$1", [conversationId])).rows[0].current_leaf_id;
  await pool.query("INSERT INTO messages (id,conversation_id,parent_id,role,parts) VALUES ($1,$2,$3,'assistant',$4)", [id, conversationId, leaf, JSON.stringify([{ type: "data-run-error", data: { message: "Fixture: provider connection interrupted." } }])]);
  await pool.query("UPDATE conversations SET current_leaf_id=$1 WHERE id=$2", [id, conversationId]);
  await page.reload(); await expect(pet).toContainText("This reply needs attention");
  await send(page, "Continue with a fresh thought."); await expect(pet).toContainText("Idle in this chat", { timeout: 30_000 });
});

test("an idle home keeps its sidebar pet's outstanding side-chat approval", async ({ page }) => {
  await login(page, "alice"); await openBot(page, botName); await enable(page);
  const home = page.url();
  await page.getByRole("button", { name: "Start side chat", exact: true }).click();
  await expect(page).not.toHaveURL(home);
  await send(page, '[tool:fetch_url {"url":"https://example.com/private-avatar-approval"}]');
  await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible();
  const side = page.url();
  await page.getByRole("link", { name: "Open home chat", exact: true }).click();
  await expect(page).toHaveURL(home);
  await expect(avatar(page)).toHaveAttribute("data-activity", "idle");
  await expect(page.locator(`nav [data-bot-avatar="${botId}"]`)).toHaveAttribute("data-activity", "approval");
  await expect(page.locator(`nav a[href="/?bot=${botId}"]`)).toContainText("Needs your approval");
  await page.reload();
  await expect(page.locator(`nav [data-bot-avatar="${botId}"]`)).toHaveAttribute("data-activity", "approval");
  await page.goto(side); await page.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(activity(page)).toContainText("Idle in this chat", { timeout: 30_000 });
  await expect(page.locator(`nav [data-bot-avatar="${botId}"]`)).not.toHaveAttribute("data-activity", "approval");
});

test("mobile header, reduced motion, nested dialog focus and unobscured composer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await login(page, "alice"); await openBot(page, botName); await enable(page);
  await expect(settings(page)).toBeFocused();
  await settings(page).click();
  const dialog = page.getByRole("dialog", { name: "Pet avatar", exact: true });
  for (let n = 0; n < 14; n++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await page.getByText("Import your own pet", { exact: true }).click();
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(settings(page)).toBeFocused();
  await page.getByRole("dialog").getByRole("button", { name: "Hide bot details" }).click();
  const pet = avatar(page);
  await expect(pet.locator(".pet-body")).toHaveCSS("animation-name", "none");
  await send(page, "A tiny mobile hello.");
  await expect(activity(page)).toContainText("Idle in this chat", { timeout: 30_000 });
  const box = await page.getByLabel("Message", { exact: true }).boundingBox();
  const petBox = await pet.boundingBox();
  expect(box && petBox && petBox.y + petBox.height < box.y).toBeTruthy();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel("Message", { exact: true }).fill("Still reachable");
  await expect(page.getByLabel("Send message")).toBeEnabled();
  await page.setViewportSize({ width: 320, height: 568 });
  await expect(page.getByLabel("Send message")).toBeInViewport();
  await expect(pet).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("private import, normalized bytes, bad assets, CSRF and revoked access", async ({ page, browser }) => {
  await login(page, "alice"); await openBot(page, botName);
  const png = await sharp({ create: { width: 1536, height: 2288, channels: 4, background: "#6a805c88" } }).png().toBuffer();
  const manifest = { displayName: "My private sample", description: "Original geometric test fixture", spritesheetPath: "spritesheet.png", spriteVersionNumber: 2 };
  const multipart = { manifest: { name: "pet.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(manifest)) }, sprite: { name: "spritesheet.png", mimeType: "image/png", buffer: png }, credit: "CollectiveUI test fixture · MIT", rights: "confirmed" };
  expect((await page.request.post(endpoint, { headers: { origin }, multipart })).status()).toBe(200);
  expect((await page.request.patch(endpoint, { headers: { origin }, data: { ...pref, appearance: "custom" } })).status()).toBe(200);
  await page.reload(); const pet = avatar(page);
  await expect(pet).toHaveAttribute("data-pet-appearance", "custom");
  await expect(pet.locator("img")).toHaveJSProperty("naturalWidth", 1536);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(pet.locator("img")).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(pet.locator("img")).toHaveCSS("animation-name", "pet-frames");
  await page.route(`**${endpoint}/avatar?*`, (route) => route.fulfill({ status: 404 }));
  await page.reload();
  await expect(pet.locator(".pet-art")).toHaveCount(0);
  await expect(pet).toContainText("🤖");
  await page.unroute(`**${endpoint}/avatar?*`); await page.reload();
  await expect(pet.locator("img")).toHaveJSProperty("naturalWidth", 1536);
  const sprite = await page.request.get(spriteUrl);
  expect(sprite.headers()["content-type"]).toBe("image/png");
  expect(sprite.headers()["cache-control"]).toBe("private, no-store");
  const other = await browser.newContext(); const bob = await other.newPage();
  await login(bob, "bob");
  await expect(bob.locator(`img[src*="${spriteUrl}"]`)).toHaveCount(0);
  expect((await bob.request.get(endpoint)).status()).toBe(403);
  expect((await bob.request.get(spriteUrl)).status()).toBe(403);
  await other.close();
  const anonymous = await browser.newContext();
  expect((await anonymous.request.get(spriteUrl, { maxRedirects: 0 })).status()).not.toBe(200);
  await anonymous.close();
  expect((await page.request.patch(endpoint, { data: pref, headers: { origin: "https://foreign.example" } })).status()).toBe(403);
  for (const spritesheetPath of ["https://127.0.0.1/internal", "../spritesheet.png", "pet.svg"]) {
    expect((await page.request.post(endpoint, { headers: { origin }, multipart: { ...multipart, manifest: { ...multipart.manifest, buffer: Buffer.from(JSON.stringify({ ...manifest, spritesheetPath })) } } })).status()).toBe(400);
  }
  expect((await page.request.post(endpoint, { headers: { origin }, multipart: { ...multipart, sprite: { ...multipart.sprite, buffer: Buffer.from('<svg onload="alert(1)"/>') } } })).status()).toBe(415);
  expect((await page.request.post(endpoint, { headers: { origin }, multipart: { ...multipart, rights: "" } })).status()).toBe(400);
  expect((await page.request.patch(endpoint, { headers: { origin }, data: { ...pref, userId: ownerId } })).status()).toBe(400);
  // Failed imports preserve the previous validated image and preferences.
  expect(await (await page.request.get(endpoint)).json()).toMatchObject({ enabled: true, appearance: "custom", custom: { displayName: "My private sample" } });
  await preferences(page);
  await page.getByText("Import your own pet", { exact: true }).click();
  await expect(page.getByText("Credit: CollectiveUI test fixture · MIT").first()).toBeVisible();
  // Exercise the actual file-input flow, not just HTTP upload.
  await page.getByLabel("pet.json", { exact: true }).setInputFiles({ name: "pet.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ...manifest, displayName: "Updated private sample" })) });
  await page.getByLabel("Sprite sheet", { exact: true }).setInputFiles(multipart.sprite);
  await page.getByLabel("I have permission to use this artwork", { exact: false }).check();
  await page.getByRole("button", { name: "Import pet", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Pet imported" })).toBeVisible();
  await page.getByRole("button", { name: "Remove imported pet" }).click();
  await expect(page.getByRole("button", { name: "Remove imported pet" })).toBeHidden();
  expect((await page.request.get(spriteUrl)).status()).toBe(404);
  await pool.query("UPDATE bots SET enabled=false WHERE id=$1", [botId]);
  expect((await page.request.get(endpoint)).status()).toBe(403);
  expect((await page.request.get(spriteUrl)).status()).toBe(403);
  await pool.query("UPDATE bots SET enabled=true WHERE id=$1", [botId]);
});
