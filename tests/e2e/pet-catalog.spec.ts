import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { petV2Fixture } from "../fixtures/pet-v2";
import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { hashPassword } from "../../src/lib/auth/password";
import { choose } from "./helpers";

test.skip(process.env.PET_CATALOG_BROWSER !== "1", "Disposable synthetic installation required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const password = "Synthetic-pet-browser!42";
const origin = process.env.BASE_URL ?? "http://localhost:3116";
const bot = "petcatalogshared", name = "Studio Companion";
const endpoint = `/api/bots/${bot}/pet`;
const screens = "/tmp/collective-pet-identity-screenshots";
const personalId = "petcatalogpersonal", personalEndpoint = `/api/bots/${personalId}/pet`;
let png: Buffer;
const manifest = { displayName: "Studio Sprout", description: "An original synthetic sprite for catalog browser tests.", spritesheetPath: "spritesheet.png", spriteVersionNumber: 2 };
async function login(page: Page, role: string) {
  await page.goto("/login");
  await page.getByLabel("Local username or email").fill(`pet-${role}`);
  await page.getByLabel("Local password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in with local account" }).click();
  await page.waitForURL("/");
}
const avatar = (page: Page) => page.locator(`header [data-bot-avatar="${bot}"]`).first();
async function openSettings(page: Page, botName = name) {
  const button = page.getByRole("button", { name: `Pet avatar settings for ${botName}`, exact: true });
  await expect.poll(async () => await button.isVisible() || await page.getByRole("button", { name: "Show bot panel" }).isVisible()).toBe(true);
  if (!await button.isVisible()) await page.getByRole("button", { name: "Show bot panel" }).click();
  await button.click();
  await expect(page.getByRole("combobox", { name: "Animation", exact: true })).toBeEnabled();
}
async function mode(page: Page, label: string) {
  const radio = page.getByRole("radio", { name: label, exact: true });
  await radio.focus(); await page.keyboard.press("Space");
  await expect(radio).toBeChecked(); await expect(radio).toBeEnabled();
}
async function upload(page: Page, personal = false) {
  await page.getByLabel("pet.json", { exact: true }).setInputFiles({ name: "pet.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(manifest)) });
  await page.getByLabel("Sprite sheet", { exact: true }).setInputFiles({ name: "spritesheet.png", mimeType: "image/png", buffer: png });
  await page.getByLabel("Artist and license credit").fill("CollectiveUI synthetic fixture · MIT");
  await page.getByRole("checkbox", { name: personal ? "I have permission to use this artwork and have included any required credit." : "I have permission to use and share this artwork with all signed-in users and have included any required credit.", exact: true }).check();
  await page.getByRole("button", { name: "Validate and preview", exact: true }).click();
  await page.getByRole("checkbox", { name: "I reviewed all animation states", exact: false }).check();
  await page.getByRole("button", { name: personal ? "Import pet" : "Upload draft", exact: true }).click();
}

test.beforeAll(async () => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/collective_pets_test") throw new Error("Disposable pet fixture database required");
  await mkdir(screens, { recursive: true });
  const hash = await hashPassword(password);
  await pool.query("DELETE FROM users WHERE id IN ('pet-admin','pet-member','pet-outsider')");
  await pool.query("DELETE FROM pet_catalog WHERE manifest->>'displayName'='Studio Sprout'");
  await pool.query("DELETE FROM ai_apps WHERE id='pet-model'");
  for (const role of ["admin", "member", "outsider"]) {
    await pool.query("INSERT INTO users(id,upn,name,identity_realm,auth_source,is_admin) VALUES ($1,$2,$3,'local','local',$4)", [`pet-${role}`, `local:pet-${role}`, `Pet ${role}`, role === "admin"]);
    await pool.query("INSERT INTO local_credentials(user_id,username,password_hash,must_change_password) VALUES ($1,$1,$2,false)", [`pet-${role}`, hash]);
    await pool.query("INSERT INTO local_login_aliases(login,user_id) VALUES ($1,$1)", [`pet-${role}`]);
  }
  await pool.query("DELETE FROM auth_throttle");
  await pool.query("INSERT INTO ai_apps(id,name,provider,model,base_url,is_public,supports_tools) VALUES ('pet-model','Synthetic chat model','openai-compatible','fixture','https://unused.invalid',true,true)");
  await pool.query("INSERT INTO bots(id,owner_id,name,app_id,visibility) VALUES ($1,'pet-member',$2,'pet-model','org'),('petcatalogprivate','pet-admin','Private fixture','pet-model','private'),('petcatalogsecond','pet-admin','Team Partner','pet-model','org'),('petcatalogpersonal','pet-member','Private member fixture','pet-model','private')", [bot, name]);
  await pool.query("UPDATE bots SET avatar='🛰️' WHERE id=$1", [bot]);
  await pool.query("INSERT INTO user_bot_prefs(user_id,bot_id,pinned) VALUES ('pet-member',$1,true),('pet-admin',$1,true)", [bot]);
  // Generated test artwork only. No private or gallery files are checked into source control.
  png = await petV2Fixture();
});
test.afterAll(async () => { await pool.end(); });

test("admin catalog publication and two-user inherited avatars, privacy, revocation and recovery", async ({ page: admin, browser }) => {
  const memberContext = await browser.newContext(); const member = await memberContext.newPage();
  const viewerContext = await browser.newContext(); const viewer = await viewerContext.newPage();
  await login(admin, "admin"); await login(member, "member"); await login(viewer, "outsider");
  let id: string, revision: string;
  await test.step("admin uploads and reviews a private draft", async () => {
    await admin.goto("/admin/pets"); await upload(admin);
    await expect(admin.getByRole("status").filter({ hasText: "Draft uploaded" })).toBeVisible();
    const items = await (await admin.request.get("/api/admin/pets")).json();
    ({ id, revision } = items.find((p: { manifest: { displayName: string } }) => p.manifest.displayName === manifest.displayName));
    await expect(admin.locator(`article[id="${id}"] img`)).toHaveJSProperty("naturalWidth", 1536);
    const denied = await member.request.get(`/api/pets/catalog/${id}/sprite?v=${revision}`);
    expect(denied.status()).toBe(404); expect(denied.headers()["cache-control"]).toBe("private, no-store");
    expect((await member.request.get("/api/admin/pets")).status()).toBe(403);
    expect(await (await member.request.get("/api/pets/catalog")).json()).not.toContainEqual(expect.objectContaining({ id }));
    expect((await viewer.request.put(`${endpoint}/default`, { headers: { origin }, data: { appearance: "catalog", catalogId: id } })).status()).toBe(403);
    expect((await member.request.put(`${endpoint}/default`, { headers: { origin }, data: { appearance: "catalog", catalogId: id } })).status()).toBe(400);
    expect((await admin.request.put(`${endpoint}/default`, { headers: { origin }, data: { appearance: "catalog", catalogId: id } })).status()).toBe(400);
    await admin.screenshot({ path: `${screens}/01-admin-draft.png`, fullPage: true });
    const card = admin.locator(`article[id="${id}"]`);
    expect((await admin.request.patch(`/api/admin/pets/${id}`, { headers: { origin }, data: { status: "published" } })).status()).toBe(400);
    await card.getByRole("button", { name: "Publish pet", exact: true }).click();
    await expect(card.getByRole("checkbox")).not.toBeChecked();
    await expect(card.getByRole("button", { name: "Publish pet", exact: true })).toBeVisible();
    await card.getByRole("checkbox").check(); await card.getByRole("button", { name: "Publish pet", exact: true }).click();
    await expect(card.getByRole("button", { name: "Unpublish pet" })).toBeVisible();
    await choose(admin, admin.getByLabel("Bot to configure", { exact: true }), bot);
    const original = admin.getByRole("radio", { name: "Original bot icon", exact: true });
    await expect(original.locator("..")).toContainText("🛰️");
    for (const label of ["Moss", "Ember"]) await expect(admin.getByRole("radio", { name: label, exact: true }).locator("..").locator("svg.pet-seedling")).toBeVisible();
    await original.focus(); await admin.keyboard.press("ArrowRight");
    await expect(admin.getByRole("radio", { name: "Moss", exact: true })).toBeChecked();
    await admin.keyboard.press("ArrowRight"); await expect(admin.getByRole("radio", { name: "Ember", exact: true })).toBeChecked();
    await admin.keyboard.press("ArrowRight");
    const selected = admin.getByRole("radio", { name: manifest.displayName, exact: true });
    await expect(selected).toBeChecked();
    await expect(selected.locator("..").locator("img")).toHaveJSProperty("naturalWidth", 1536);
    await expect(selected.locator("..").locator("img")).toHaveAttribute("src", `/api/pets/catalog/${id}/sprite?v=${revision}`);
    await expect(selected.locator("..").locator("img")).toHaveCSS("animation-name", "none");
    await admin.getByRole("button", { name: "Save bot pet", exact: true }).click();
    await expect(admin.getByRole("status").filter({ hasText: "Shared bot pet saved" })).toBeVisible();
    await expect(card).toContainText("1 bot defaults");
    await admin.screenshot({ path: `${screens}/02-admin-published.png`, fullPage: true });
    await admin.setViewportSize({ width: 390, height: 844 });
    expect(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await admin.setViewportSize({ width: 1360, height: 1000 });
  });
  await test.step("shared default thumbnails fail safely and retain the selected choice", async () => {
    await admin.route(`**/api/pets/catalog/${id}/sprite?*`, route => route.fulfill({ status: 404 }));
    await admin.reload(); await choose(admin, admin.getByLabel("Bot to configure", { exact: true }), bot);
    const selected = admin.getByRole("radio", { name: manifest.displayName, exact: true });
    await expect(selected).toBeChecked();
    await expect(selected.locator("..")).toContainText("Preview unavailable");
    await expect(selected.locator("..").locator("svg")).toHaveCount(0);
    await admin.setViewportSize({ width: 390, height: 844 });
    expect(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await admin.setViewportSize({ width: 1360, height: 1000 });
    await admin.unroute(`**/api/pets/catalog/${id}/sprite?*`); await admin.reload();
    await choose(admin, admin.getByLabel("Bot to configure", { exact: true }), bot);
    await expect(selected).toBeChecked(); await expect(selected.locator("..").locator("img")).toHaveJSProperty("naturalWidth", 1536);
  });
  await test.step("save confirmations survive refresh, clear on failure, and stay with the saved bot", async () => {
    await admin.getByRole("button", { name: "Save bot pet", exact: true }).click();
    await expect(admin.getByRole("status").filter({ hasText: "Shared bot pet saved" })).toBeVisible();
    await admin.getByRole("radio", { name: "Ember", exact: true }).check();
    await admin.route(`**${endpoint}/default`, route => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "Synthetic permission change" }) }));
    await admin.getByRole("button", { name: "Save bot pet", exact: true }).click();
    await expect(admin.getByRole("alert").filter({ hasText: "Synthetic permission change" })).toBeVisible();
    await expect(admin.getByRole("status").filter({ hasText: "Shared bot pet saved" })).toHaveCount(0);
    await admin.unroute(`**${endpoint}/default`);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await admin.route(`**${endpoint}/default`, async route => { await held; await route.continue(); });
    const requested = admin.waitForRequest(`**${endpoint}/default`);
    await admin.getByRole("button", { name: "Save bot pet", exact: true }).click(); await requested;
    await choose(admin, admin.getByLabel("Bot to configure", { exact: true }), "petcatalogsecond");
    const finished = admin.waitForResponse(`**${endpoint}/default`); release(); await finished;
    await expect(admin.getByRole("status").filter({ hasText: "Shared bot pet saved" })).toHaveCount(0);
    await expect(admin.getByLabel("Bot to configure", { exact: true })).toContainText("Team Partner");
    await admin.unroute(`**${endpoint}/default`);
    expect((await admin.request.put(`${endpoint}/default`, { headers: { origin }, data: { appearance: "catalog", catalogId: id } })).status()).toBe(200);
  });
  await test.step("shared identity is consistent everywhere; owner controls and viewer-only motion work by keyboard", async () => {
    await member.goto(`/?bot=${bot}`); await member.waitForURL(/\/c\//);
    for (const location of [avatar(member), member.locator(`nav [data-bot-avatar="${bot}"]`), member.locator(`aside [data-bot-avatar="${bot}"]`).last()]) {
      await expect(location).toHaveAttribute("data-pet-appearance", "catalog");
      await expect(location.locator("img")).toHaveJSProperty("naturalWidth", 1536);
      await expect(location.locator("img")).toHaveCSS("animation-name", "pet-frames");
    }
    const inherited = await (await member.request.get(endpoint)).json();
    expect(inherited).toMatchObject({ source: "default", preference: { mode: "follow" }, privateImport: null });
    const image = await member.request.get(inherited.spriteUrl);
    expect(image.headers()["cache-control"]).toBe("private, no-store"); expect(image.headers()["vary"]).toContain("Cookie");
    await member.screenshot({ path: `${screens}/03-member-inherited.png`, fullPage: true });
    await member.goto(`/bots/${bot}`); await expect(member.locator(`main [data-bot-avatar="${bot}"]`)).toHaveAttribute("data-pet-appearance", "catalog");
    await member.goto("/bots"); await expect(member.getByRole("link", { name: `Chat with ${name}`, exact: true }).locator("[data-bot-avatar]")).toHaveAttribute("data-pet-appearance", "catalog");
    await member.goto(`/?bot=${bot}`); await openSettings(member);
    await expect(member.getByRole("radio", { name: "Personal pet", exact: true })).toHaveCount(0);
    await expect(member.getByText("Import your own pet", { exact: true })).toHaveCount(0);
    await member.getByText("Shared bot pet", { exact: true }).click();
    await expect(member.getByRole("radio", { name: "Original bot icon", exact: true }).locator("..")).toContainText("🛰️");
    const catalogCard = member.getByRole("radio", { name: manifest.displayName, exact: true });
    await expect(catalogCard.locator("..").locator("img")).toHaveJSProperty("naturalWidth", 1536);
    await mode(member, "Ember"); await member.getByRole("button", { name: "Save bot pet", exact: true }).click();
    await expect(member.getByRole("status").filter({ hasText: "Shared bot pet saved" })).toBeVisible();
    await member.keyboard.press("Escape"); await member.reload(); await expect(avatar(member)).toHaveAttribute("data-pet-appearance", "ember");
    await viewer.goto(`/?bot=${bot}`); await expect(avatar(viewer)).toHaveAttribute("data-pet-appearance", "ember");
    await openSettings(viewer);
    await expect(viewer.getByRole("radio")).toHaveCount(0);
    await expect(viewer.getByText("Shared bot pet", { exact: true })).toHaveCount(0);
    await choose(viewer, viewer.getByRole("combobox", { name: "Animation", exact: true }), "still");
    await expect(viewer.getByRole("status").filter({ hasText: "Preferences saved" })).toBeVisible();
    await viewer.keyboard.press("Escape"); await viewer.reload();
    await expect(avatar(viewer).locator("[data-pet-art]")).toHaveAttribute("data-still", "true");
    for (const actor of [admin, member, viewer]) {
      expect((await actor.request.patch(endpoint, { headers: { origin }, data: { mode: "off", appearance: "moss", catalogId: null, motion: "auto" } })).status()).toBe(403);
      expect((await actor.request.delete(endpoint, { headers: { origin } })).status()).toBe(403);
      expect((await actor.request.post(endpoint, { headers: { origin }, multipart: { manifest: { name: "pet.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(manifest)) }, sprite: { name: "spritesheet.png", mimeType: "image/png", buffer: png }, credit: "MIT", rights: "confirmed" } })).status()).toBe(403);
    }
    expect((await viewer.request.patch(`${endpoint}/motion`, { headers: { origin }, data: { motion: "auto", appearance: "moss" } })).status()).toBe(400);
    expect((await member.request.put(`${endpoint}/default`, { headers: { origin }, data: { appearance: "catalog", catalogId: id } })).status()).toBe(200);
    await member.reload(); await expect(avatar(member)).toHaveAttribute("data-pet-appearance", "catalog");
    await openSettings(member); await member.getByText("Shared bot pet", { exact: true }).click();
    await member.screenshot({ path: `${screens}/04-owner-controls.png`, fullPage: true });
    await member.keyboard.press("Escape");
  });
  await test.step("New and Edit bot configure real previews, atomic choices and audience transitions", async () => {
    await admin.goto("/bots/new"); await admin.getByRole("button", { name: "configure", exact: true }).click();
    const section = admin.getByRole("region", { name: "Pet avatar configuration", exact: true });
    await expect(section.getByRole("radio", { name: "Original bot icon", exact: true })).toBeChecked();
    await expect(section.getByRole("radio", { name: manifest.displayName, exact: true }).locator("..").locator("img")).toHaveJSProperty("naturalWidth", 1536);
    // The header avatar follows the unsaved choice immediately (#24); Original restores the editable icon.
    await expect(admin.getByRole("button", { name: "Change avatar", exact: true })).toBeVisible();
    const header = admin.getByTestId("builder-avatar-preview");
    await mode(admin, "Ember"); await expect(header).toHaveAttribute("data-pet-appearance", "ember");
    await mode(admin, manifest.displayName); await expect(header).toHaveAttribute("data-pet-appearance", "catalog");
    await expect(header.getByRole("img", { name: `Avatar preview: ${manifest.displayName}`, exact: true })).toBeVisible();
    await expect(header.locator("img")).toHaveJSProperty("naturalWidth", 1536);
    await admin.emulateMedia({ reducedMotion: "reduce" });
    await expect(header.locator("img")).toHaveCSS("animation-name", "none");
    await admin.emulateMedia({ reducedMotion: "no-preference" });
    await admin.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(header.locator("[data-pet-art]")).toHaveAttribute("data-still", "true");
    await admin.evaluate(() => {
      Reflect.deleteProperty(document, "visibilityState");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(header.locator("[data-pet-art]")).toHaveAttribute("data-still", "false");
    // A failed catalog image restores the original icon without overwriting the unsaved choice.
    await mode(admin, "Original bot icon");
    await admin.route(`**/api/pets/catalog/${id}/sprite?*`, route => route.fulfill({ status: 404 }));
    await mode(admin, manifest.displayName);
    await expect(header.locator("[data-pet-art]")).toHaveCount(0);
    await expect(header.getByRole("img", { name: `Avatar preview: ${manifest.displayName}`, exact: true }).locator("svg")).toBeVisible();
    await expect(section.getByRole("radio", { name: manifest.displayName, exact: true })).toBeChecked();
    await admin.unroute(`**/api/pets/catalog/${id}/sprite?*`);
    await mode(admin, "Original bot icon"); await expect(header).toHaveCount(0);
    await expect(admin.getByRole("button", { name: "Change avatar", exact: true })).toBeVisible();
    await mode(admin, manifest.displayName);
    await admin.getByRole("button", { name: "create", exact: true }).click();
    await admin.getByRole("button", { name: "configure", exact: true }).click();
    await expect(section.getByRole("radio", { name: manifest.displayName, exact: true })).toBeChecked();
    await admin.getByPlaceholder("Name your bot").fill("Builder catalog fixture");
    await choose(admin, admin.getByRole("combobox", { name: "Model connection", exact: true }), "pet-model");
    await choose(admin, admin.getByRole("combobox", { name: "Who can use it", exact: true }), "org");
    await section.scrollIntoViewIfNeeded();
    await admin.screenshot({ path: `${screens}/06-new-bot-catalog.png`, fullPage: true });
    await admin.getByRole("button", { name: "Create", exact: true }).click(); await admin.waitForURL(/\/bots\/.+\/edit/, { timeout: 15000 });
    const created = admin.url().split("/").at(-2)!;
    const createdEndpoint = `/api/bots/${created}/pet`;
    await expect(header).toHaveAttribute("data-pet-appearance", "catalog");
    await expect(header.locator("img")).toHaveJSProperty("naturalWidth", 1536);
    await expect(header.getByRole("button", { name: "Change avatar", exact: true })).toBeVisible();
    expect((await (await viewer.request.get(createdEndpoint)).json())).toMatchObject({ source: "default", appearance: "catalog", sharedIdentity: true });
    const before = (await pool.query("SELECT revision,published_revision,published_config_hash FROM bots WHERE id=$1", [created])).rows[0];
    await openSettings(admin, "Builder catalog fixture"); await admin.getByText("Shared bot pet", { exact: true }).click(); await mode(admin, "Ember");
    await admin.getByRole("button", { name: "Save bot pet", exact: true }).click();
    await expect(admin.getByRole("status").filter({ hasText: "Shared bot pet saved" })).toBeVisible();
    expect((await pool.query("SELECT revision,published_revision,published_config_hash FROM bots WHERE id=$1", [created])).rows[0]).toEqual(before);
    await admin.keyboard.press("Escape");
    await expect(header).toHaveAttribute("data-pet-appearance", "ember");
    await choose(admin, admin.getByRole("combobox", { name: "Who can use it", exact: true }), "private");
    await admin.getByRole("button", { name: "Update", exact: true }).click(); await expect(admin.getByText("Bot updated", { exact: true })).toBeVisible();
    // The save refresh remounts the revision-keyed builder. Open settings on the settled page.
    await admin.reload();
    await openSettings(admin, "Builder catalog fixture"); await mode(admin, "Off · original icon"); await admin.keyboard.press("Escape");
    await expect(header).toHaveCount(0);
    await expect(admin.getByRole("button", { name: "Change avatar", exact: true })).toBeVisible();
    await choose(admin, admin.getByRole("combobox", { name: "Who can use it", exact: true }), "org");
    await admin.getByRole("button", { name: "Update", exact: true }).click();
    await expect.poll(async () => (await (await admin.request.get(createdEndpoint)).json()).sharedIdentity).toBe(true);
    await admin.reload();
    await openSettings(admin, "Builder catalog fixture"); await expect(admin.getByRole("radio", { name: "Off · original icon", exact: true })).toHaveCount(0);
    expect((await (await admin.request.get(createdEndpoint)).json())).toMatchObject({ enabled: true, appearance: "ember", preference: { mode: "off" } });
    await admin.screenshot({ path: `${screens}/07-edit-shared-controls.png`, fullPage: true }); await admin.keyboard.press("Escape");
    await choose(admin, admin.getByRole("combobox", { name: "Who can use it", exact: true }), "private");
    await admin.getByRole("button", { name: "Update", exact: true }).click();
    await expect.poll(async () => (await (await admin.request.get(createdEndpoint)).json()).sharedIdentity).toBe(false);
    await admin.reload();
    await openSettings(admin, "Builder catalog fixture"); await expect(admin.getByRole("radio", { name: "Off · original icon", exact: true })).toBeChecked();
    await admin.keyboard.press("Escape");
    await admin.goto("/bots/new"); await admin.getByRole("button", { name: "configure", exact: true }).click();
    await mode(admin, manifest.displayName); await admin.getByPlaceholder("Name your bot").fill("Rejected atomic pet fixture");
    await choose(admin, admin.getByRole("combobox", { name: "Model connection", exact: true }), "pet-model");
    expect((await admin.request.patch(`/api/admin/pets/${id}`, { headers: { origin }, data: { status: "unpublished" } })).status()).toBe(200);
    const rejectedCreation = admin.waitForResponse((response) => response.url().endsWith("/bots/new") && response.request().method() === "POST");
    await admin.getByRole("button", { name: "Create", exact: true }).click(); await rejectedCreation;
    await expect(admin.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
    expect(admin.url()).toContain("/bots/new");
    expect((await pool.query("SELECT id FROM bots WHERE name='Rejected atomic pet fixture'")).rowCount).toBe(0);
    expect((await admin.request.patch(`/api/admin/pets/${id}`, { headers: { origin }, data: { status: "published", rights: "confirmed" } })).status()).toBe(200);
    await admin.goto("/admin/pets");
  });
  await test.step("focus and visibility events coalesce while a refresh is in flight", async () => {
    let requests = 0; let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await member.route("**/api/pets/preferences", async (route) => { requests++; await held; await route.continue(); });
    const requested = member.waitForRequest("**/api/pets/preferences");
    await member.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await requested;
    // Let the browser deliver every dispatched event while the first request is held.
    await member.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(requests).toBe(1);
    const finished = member.waitForResponse("**/api/pets/preferences"); release(); await finished;
    await member.unroute("**/api/pets/preferences");
  });
  await test.step("new server props cancel older preference polling responses", async () => {
    const old = await (await member.request.get("/api/pets/preferences")).json();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let captured = false;
    await member.route("**/api/pets/preferences", async (route) => {
      if (captured) { await route.continue(); return; }
      captured = true; await held;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(old) });
    });
    const requested = member.waitForRequest("**/api/pets/preferences");
    await member.evaluate(() => window.dispatchEvent(new Event("focus"))); await requested;
    const cancelled = member.waitForEvent("requestfailed", { predicate: (request) => request.url().endsWith("/api/pets/preferences"), timeout: 10_000 });
    expect((await admin.request.put(`${endpoint}/default`, { headers: { origin }, data: { appearance: "moss", catalogId: null } })).status()).toBe(200);
    await member.getByRole("button", { name: `${name} options`, exact: true }).click();
    await member.getByRole("menuitem", { name: "Unpin", exact: true }).click(); // revalidates the chat layout in-place
    await expect(avatar(member)).toHaveAttribute("data-pet-appearance", "moss");
    release(); await cancelled;
    await expect(avatar(member)).toHaveAttribute("data-pet-appearance", "moss");
    await member.unroute("**/api/pets/preferences");
    expect((await admin.request.put(`${endpoint}/default`, { headers: { origin }, data: { appearance: "catalog", catalogId: id } })).status()).toBe(200);
    await member.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(avatar(member)).toHaveAttribute("data-pet-appearance", "catalog");
  });
  await test.step("shared artwork reaches group speaker markers without exposing personal imports", async () => {
    await pool.query("INSERT INTO conversations(id,user_id,title,is_group) VALUES ('petcataloggroup','pet-member','Design group',true)");
    await pool.query("INSERT INTO conversation_bots(conversation_id,bot_id,position) VALUES ('petcataloggroup',$1,0),('petcataloggroup','petcatalogsecond',1)", [bot]);
    await pool.query("INSERT INTO messages(id,conversation_id,role,parts) VALUES ('petcatalogmessage','petcataloggroup','assistant',$1)", [JSON.stringify([{ type: "data-speaker", data: { botId: bot, name, avatar: null } }, { type: "text", text: "A shared companion for the whole team." }])]);
    await pool.query("UPDATE conversations SET current_leaf_id='petcatalogmessage' WHERE id='petcataloggroup'");
    await member.goto("/c/petcataloggroup");
    await expect(member.locator(`main [data-bot-avatar="${bot}"].mb-0\\.5`)).toHaveAttribute("data-pet-appearance", "catalog");
    await member.goto(`/?bot=${bot}`);
  });
  await test.step("system motion, narrow-screen controls and transient asset failure recover", async () => {
    await member.emulateMedia({ reducedMotion: "reduce" }); await expect(avatar(member).locator("img")).toHaveCSS("animation-name", "none");
    await member.setViewportSize({ width: 390, height: 844 }); await openSettings(member);
    const dialog = member.getByRole("dialog", { name: "Pet avatar", exact: true });
    await expect(dialog).toBeInViewport();
    for (let i = 0; i < 12; i++) { await member.keyboard.press("Tab"); expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true); }
    expect(await member.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await member.getByText("Shared bot pet", { exact: true }).click();
    await expect(member.getByRole("radio", { name: manifest.displayName, exact: true })).toBeVisible();
    expect(await member.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await member.screenshot({ path: `${screens}/05-mobile-preferences.png`, fullPage: true });
    await member.keyboard.press("Escape"); await member.setViewportSize({ width: 1360, height: 1000 }); await member.emulateMedia({ reducedMotion: "no-preference" });
    await member.route(`**${endpoint}/avatar?*`, (route) => route.fulfill({ status: 404 }));
    await member.reload(); await expect(avatar(member).locator(".pet-art")).toHaveCount(0);
    await member.unroute(`**${endpoint}/avatar?*`);
    await expect(avatar(member).locator("img")).toHaveJSProperty("naturalWidth", 1536, { timeout: 8000 });
  });
  await test.step("unpublish and republish revoke bytes and preserve deliberate selections", async () => {
    expect((await member.request.patch(personalEndpoint, { headers: { origin }, data: { mode: "personal", appearance: "catalog", catalogId: id, motion: "auto" } })).status()).toBe(200);
    await admin.reload();
    await expect(admin.locator(`article[id="${id}"]`)).toContainText("1 personal selections");
    await expect(admin.locator(`article[id="${id}"]`)).toContainText("Unpublishing affects bot defaults and personal selections");
    const card = admin.locator(`article[id="${id}"]`); await card.getByRole("button", { name: "Unpublish pet" }).click();
    await expect(card.getByRole("button", { name: "Publish pet" })).toBeVisible();
    const denied = await member.request.get(`/api/pets/catalog/${id}/sprite?v=${revision}`);
    expect(denied.status()).toBe(404); expect(denied.headers()["cache-control"]).toBe("private, no-store");
    expect((await member.request.get(`${endpoint}/avatar?v=${revision}`)).status()).toBe(404);
    await member.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(avatar(member)).toHaveAttribute("data-pet-enabled", "false"); await member.reload(); await expect(avatar(member)).toHaveAttribute("data-pet-enabled", "false");
    await openSettings(member); await member.getByText("Shared bot pet", { exact: true }).click();
    await expect(member.getByText("Your selected catalog pet is unavailable.", { exact: false })).toBeVisible();
    await expect(member.getByRole("radio", { name: manifest.displayName, exact: true })).toHaveCount(0);
    await member.keyboard.press("Escape");
    await card.getByRole("checkbox").check(); await card.getByRole("button", { name: "Publish pet" }).click();
    await expect(card.getByRole("button", { name: "Unpublish pet" })).toBeVisible();
    await member.evaluate(() => window.dispatchEvent(new Event("focus"))); await expect(avatar(member)).toHaveAttribute("data-pet-enabled", "true");
    await expect(avatar(member).locator("img")).toHaveJSProperty("naturalWidth", 1536);
  });
  await test.step("private imports, explicit own publication, CSRF, bot revocation and account isolation", async () => {
    await member.goto(`/?bot=${personalId}`); await openSettings(member, "Private member fixture");
    await mode(member, "Personal pet"); await mode(member, "Ember");
    await mode(member, "Off · original icon"); await member.keyboard.press("Escape"); await member.reload();
    await expect(member.locator(`header [data-bot-avatar="${personalId}"]`)).toHaveAttribute("data-pet-enabled", "false");
    await openSettings(member, "Private member fixture"); await mode(member, "Follow bot default"); await mode(member, "Personal pet");
    await mode(member, manifest.displayName);
    await expect(member.getByRole("radio", { name: manifest.displayName, exact: true }).locator("..").locator("img")).toHaveJSProperty("naturalWidth", 1536);
    await member.getByText("Import your own pet", { exact: true }).click(); await upload(member, true);
    await expect(member.getByRole("status").filter({ hasText: "Pet imported" })).toBeVisible();
    const privateView = await (await member.request.get(personalEndpoint)).json();
    expect((await admin.request.get(`${personalEndpoint}/sprite`)).status()).toBe(404);
    expect((await admin.request.post("/api/admin/pets/from-import", { headers: { origin }, data: { botId: personalId, revision: privateView.revision, rights: "confirmed" } })).status()).toBe(409);
    expect((await member.request.post("/api/admin/pets/from-import", { headers: { origin }, data: { botId: personalId, revision: privateView.revision, rights: "confirmed" } })).status()).toBe(403);
    expect((await admin.request.put(`${endpoint}/default`, { headers: { origin: "https://attacker.invalid" }, data: { appearance: "moss", catalogId: null } })).status()).toBe(403);
    expect((await member.request.get("/api/bots/petcatalogprivate/pet")).status()).toBe(403);
    expect((await member.request.get("/api/bots/petcatalogprivate/pet/avatar?v=any")).status()).toBe(403);
    await member.keyboard.press("Escape");
    await admin.goto("/?bot=petcatalogprivate"); await openSettings(admin, "Private fixture"); await admin.getByText("Import your own pet", { exact: true }).click(); await upload(admin, true);
    await expect(admin.getByRole("status").filter({ hasText: "Pet imported" })).toBeVisible();
    await admin.getByText("Admin · Bot default", { exact: true }).click();
    await admin.getByRole("checkbox", { name: "I have permission to share this artwork and its credit with all signed-in users.", exact: true }).check();
    await admin.getByRole("button", { name: "Copy my import to admin draft" }).click();
    await expect(admin.getByRole("link", { name: "Review my draft in Admin → Pets" })).toBeVisible();
    const all = await (await admin.request.get("/api/admin/pets")).json(); expect(all.filter((p: { status: string }) => p.status === "draft")).toHaveLength(1);
    // Same browser signs out of a custom-pet account and signs into an untouched account.
    await member.getByRole("button", { name: /Pet member/ }).click();
    await member.getByRole("menuitem", { name: "Log out", exact: true }).click(); await member.waitForURL("/login");
    await login(member, "outsider"); await member.goto(`/?bot=${bot}`);
    await expect(avatar(member)).toHaveAttribute("data-pet-appearance", "catalog");
    expect((await member.request.get(`${endpoint}/sprite`)).status()).toBe(404);
    expect((await (await member.request.get(endpoint)).json()).privateImport).toBeNull();
    await pool.query("UPDATE bots SET visibility='private' WHERE id=$1", [bot]);
    expect((await member.request.get(`${endpoint}/avatar?v=${revision}`)).status()).toBe(403);
    await member.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(avatar(member)).toHaveAttribute("data-pet-enabled", "false");
    await member.reload(); await expect(member.locator(`nav [data-bot-avatar="${bot}"]`)).toHaveCount(0);
    await pool.query("UPDATE bots SET visibility='org',enabled=false WHERE id=$1", [bot]);
    expect((await member.request.get(endpoint)).status()).toBe(403);
    await pool.query("UPDATE bots SET enabled=true WHERE id=$1", [bot]);
    await member.goto(`/?bot=${bot}`); await expect(avatar(member)).toHaveAttribute("data-pet-appearance", "catalog");
    const catalog = await member.request.get(`/api/pets/catalog/${id}/sprite?v=${revision}`); expect(catalog.headers()["cache-control"]).toBe("private, no-store");
    const anonymous = await browser.newContext(); const response = await anonymous.request.get(`${origin}/api/pets/catalog/${id}/sprite?v=${revision}`, { maxRedirects: 0 });
    expect([401, 307]).toContain(response.status()); await anonymous.close();
  });
  await memberContext.close(); await viewerContext.close();
});

test("v2 builder validates without saving, cancels stale previews, inspects all cells and reimports its export", async ({ page }) => {
  await login(page, "admin"); await page.goto("/admin/pets");
  const count = (await pool.query("SELECT count(*)::int n FROM pet_catalog")).rows[0].n;
  async function selectFiles() {
    await page.getByLabel("pet.json", { exact: true }).setInputFiles({ name: "pet.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(manifest)) });
    await page.getByLabel("Sprite sheet", { exact: true }).setInputFiles({ name: "spritesheet.png", mimeType: "image/png", buffer: png });
    await page.getByLabel("Artist and license credit").fill("Roundtrip credit · MIT");
    await page.getByRole("checkbox", { name: "I have permission to use and share", exact: false }).check();
  }
  await selectFiles();
  // Delay the response until after Cancel. The stale validation must not reopen the preview.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/admin/pets?validate=1", async route => { await gate; try { await route.continue(); } catch { /* browser aborted on cancel */ } });
  await page.getByRole("button", { name: "Validate and preview", exact: true }).click();
  await page.getByRole("button", { name: "Cancel and start over" }).click(); release();
  await page.unroute("**/api/admin/pets?validate=1");
  await expect(page.getByRole("region", { name: "Codex Pet v2 preview" })).toHaveCount(0);
  await selectFiles(); await page.getByRole("button", { name: "Validate and preview", exact: true }).click();
  const preview = page.getByRole("region", { name: "Codex Pet v2 preview" });
  await expect(preview).toBeVisible();
  expect((await pool.query("SELECT count(*)::int n FROM pet_catalog")).rows[0].n).toBe(count);
  await expect(page.getByRole("button", { name: "Upload draft", exact: true })).toBeDisabled();
  await expect(preview.getByRole("group", { name: "Nine animation states" }).getByRole("button")).toHaveCount(9);
  await expect(preview.getByRole("group", { name: "Sixteen look directions", exact: false }).getByRole("button")).toHaveCount(16);
  await preview.getByRole("button", { name: "Jumping", exact: true }).click();
  await expect(preview.getByLabel("Animation frame")).toHaveAttribute("max", "4");
  await preview.getByLabel("Animation frame").fill("4"); await expect(preview).toContainText("Jumping, frame 5");
  await preview.getByRole("button", { name: "270° · Screen left", exact: true }).click(); await expect(preview).toContainText("Selected: 270° · Screen left");
  for (const theme of ["Light", "Dark"]) await expect(preview.getByText(`${theme} · actual avatar sizes`)).toBeVisible();
  for (const size of [20, 24, 28, 32, 48, 56, 64, 80, 84, 112]) await expect(preview.getByText(`${size} px`, { exact: true })).toHaveCount(2);
  await page.emulateMedia({ reducedMotion: "reduce" }); await preview.getByRole("button", { name: "Idle", exact: true }).click();
  await expect(preview.getByRole("button", { name: "Play animation" })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await preview.getByText("Light · actual avatar sizes").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${screens}/06-v2-builder-preview.png` });
  const downloaded = page.waitForEvent("download"); await page.getByRole("button", { name: "Export v2 ZIP", exact: true }).click();
  const download = await downloaded; expect(download.suggestedFilename()).toBe("codex-pet-v2.zip");
  const zip = await readFile((await download.path())!);
  await page.getByRole("button", { name: "Cancel and start over" }).click();
  await page.getByLabel("Import format", { exact: true }).selectOption("zip");
  await page.getByLabel("Pet ZIP", { exact: true }).setInputFiles({ name: "pet.zip", mimeType: "application/zip", buffer: zip });
  await page.getByRole("checkbox", { name: "I have permission to use and share", exact: false }).check();
  await page.getByRole("button", { name: "Validate and preview", exact: true }).click();
  await expect(preview).toContainText("Roundtrip credit · MIT");
  await page.getByRole("checkbox", { name: "I reviewed all animation states", exact: false }).check();
  await page.getByRole("button", { name: "Upload draft", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft uploaded" })).toBeVisible();
  expect((await pool.query("SELECT count(*)::int n FROM pet_catalog")).rows[0].n).toBe(count + 1);
  await expect(page.getByRole("button", { name: "Validate and preview", exact: true })).toBeEnabled();
});
