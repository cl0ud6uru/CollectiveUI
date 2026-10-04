import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { readFile, mkdir } from "node:fs/promises";
import { hashPassword } from "../../src/lib/auth/password";
import { choose } from "./helpers";

test.skip(process.env.BUNDLED_PETS_BROWSER !== "1", "Requires a disposable bundled-pet installation");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let validDatabase = false;
const origin = process.env.BASE_URL ?? "https://localhost:3117";
const screens = process.env.BUNDLED_PETS_SCREENSHOTS ?? "/tmp/collective-bundled-pets-screenshots";
const specimens = [
  { slug: "hermes", id: "builtin-hermes-v2", name: "Hermes", file: "spritesheet.webp" },
  { slug: "hermes-assimilated", id: "builtin-hermes-assimilated-v2", name: "Hermes Assimilated", file: "spritesheet.webp" },
  { slug: "the-queen", id: "builtin-the-queen-v2", name: "The Queen", file: "spritesheet.png" },
];
async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Local username or email").fill("bundle-browser");
  await page.getByLabel("Local password", { exact: true }).fill("Synthetic-Bundled-Pets!42");
  await page.getByRole("button", { name: "Sign in with local account" }).click();
  await page.waitForURL("/");
}

test.beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/collective_bundled_pets_test") throw new Error("Dedicated disposable bundled-pet database required");
  validDatabase = true;
  await mkdir(screens, { recursive: true });
  expect((await pool.query("SELECT id FROM pet_catalog WHERE status='published' ORDER BY id")).rows.map(row => row.id)).toEqual(specimens.map(p => p.id).sort());
  await pool.query("DELETE FROM users WHERE id='bundle-browser'");
  const hash = await hashPassword("Synthetic-Bundled-Pets!42");
  await pool.query("INSERT INTO users(id,upn,name,identity_realm,auth_source,is_admin) VALUES ('bundle-browser','local:bundle-browser','Pet preview','local','local',true)");
  await pool.query("INSERT INTO local_credentials(user_id,username,password_hash,must_change_password) VALUES ('bundle-browser','bundle-browser',$1,false)", [hash]);
  await pool.query("INSERT INTO local_login_aliases(login,user_id) VALUES ('bundle-browser','bundle-browser')");
  await pool.query("INSERT INTO bots(id,owner_id,name,visibility) VALUES ('bundle-browser-shared','bundle-browser','Companion demo','org'), ('bundle-browser-private','bundle-browser','Private companion','private')");
});
test.afterAll(async () => {
  if (validDatabase) await pool.query("DELETE FROM users WHERE id='bundle-browser'");
  await pool.end();
});

test("all three catalog pets render, retain credits, preview every state/gaze, and become a saved default", async ({ page }) => {
  await login(page); await page.goto("/admin/pets");
  for (const specimen of specimens) {
    const card = page.locator(`article[id="${specimen.id}"]`);
    await expect(card.getByRole("heading", { name: specimen.name, exact: true })).toBeVisible();
    await expect(card).toContainText("built-in · published");
    const source = JSON.parse(await readFile(`assets/pets/${specimen.slug}/v2/pet.json`, "utf8"));
    await expect(card).toContainText(source.credit);
    const img = card.locator("img.pet-atlas");
    await expect(img).toHaveJSProperty("naturalWidth", 1536); await expect(img).toHaveJSProperty("naturalHeight", 2288);
    const first = await img.evaluate(element => getComputedStyle(element).transform);
    await expect.poll(() => img.evaluate(element => getComputedStyle(element).transform)).not.toBe(first);
    await card.getByText("Inspect all states and export", { exact: true }).click();
    const preview = card.getByRole("region", { name: "Codex Pet v2 preview" });
    for (const [label, frames] of [["Idle",6],["Running right",8],["Running left",8],["Waving",4],["Jumping",5],["Failed",8],["Waiting",6],["Working",6],["Review",6]] as const) {
      await preview.getByRole("button", { name: label, exact: true }).click();
      await expect(preview.getByRole("slider", { name: "Animation frame" })).toHaveAttribute("max", String(frames - 1));
      await preview.getByRole("slider", { name: "Animation frame" }).press("End");
      await expect(preview).toContainText(`Selected: ${label}, frame ${frames}`);
    }
    const directions = preview.getByRole("group", { name: "Sixteen look directions · clockwise from up" }).getByRole("button");
    await expect(directions).toHaveCount(16);
    for (let index = 0; index < 16; index++) { await directions.nth(index).click(); await expect(directions.nth(index)).toHaveAttribute("aria-pressed", "true"); }
    if (specimen.slug === "hermes") {
      await preview.getByRole("button", { name: "Idle", exact: true }).click();
      await preview.screenshot({ path: `${screens}/hermes-preview.png` });
    }
    await card.getByText("Inspect all states and export", { exact: true }).click();
  }
  const catalog = page.locator("section").filter({ has: page.getByRole("heading", { name: "Catalog · 3", exact: true }) });
  await catalog.screenshot({ path: `${screens}/bundled-pets-catalog.png` });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  for (const specimen of specimens) await expect(page.locator(`article[id="${specimen.id}"] img.pet-atlas`)).toHaveCSS("animation-name", "none");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await catalog.screenshot({ path: `${screens}/bundled-pets-mobile.png` });
  await page.setViewportSize({ width: 1360, height: 1000 });
  await choose(page, page.getByLabel("Bot to configure", { exact: true }), "bundle-browser-shared");
  for (const specimen of specimens) {
    await page.getByRole("radio", { name: specimen.name, exact: true }).check();
    await page.getByRole("button", { name: "Save bot pet", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Shared bot pet saved for everyone." })).toBeVisible();
    await page.reload();
    await choose(page, page.getByLabel("Bot to configure", { exact: true }), "bundle-browser-shared");
    await expect(page.getByRole("radio", { name: specimen.name, exact: true })).toBeChecked();
    const result = await page.request.get("/api/bots/bundle-browser-shared/pet");
    expect(result.ok()).toBe(true); const selected = await result.json();
    expect(selected).toMatchObject({ source: "default", appearance: "catalog", custom: { displayName: specimen.name }, botDefault: { catalogId: specimen.id } });
    const sprite = await page.request.get(selected.spriteUrl); expect(sprite.ok()).toBe(true); expect(sprite.headers()["content-type"]).toContain("image/png");
  }
});

test("actual file uploads validate and save as private imports without changing bundled identities", async ({ page }) => {
  await login(page);
  const endpoint = "/api/bots/bundle-browser-private/pet";
  const before = (await pool.query("SELECT id,revision,status FROM pet_catalog ORDER BY id")).rows;
  for (const specimen of specimens) {
    const manifest = await readFile(`assets/pets/${specimen.slug}/v2/pet.json`);
    const sprite = await readFile(`assets/pets/${specimen.slug}/v2/${specimen.file}`);
    const multipart = {
      manifest: { name: "pet.json", mimeType: "application/json", buffer: manifest },
      sprite: { name: specimen.file, mimeType: specimen.file.endsWith("png") ? "image/png" : "image/webp", buffer: sprite },
      credit: "", rights: "confirmed",
    };
    const validation = await page.request.post(`${endpoint}?validate=1`, { headers: { origin }, multipart });
    expect(validation.ok()).toBe(true);
    const validated = await validation.json(); expect(validated.manifest).toMatchObject({ displayName: specimen.name, credit: JSON.parse(manifest.toString()).credit });
    const saved = await page.request.post(endpoint, { headers: { origin }, multipart }); expect(saved.ok()).toBe(true);
    const selected = await (await page.request.get(endpoint)).json();
    expect(selected).toMatchObject({ source: "personal", appearance: "custom", custom: { displayName: specimen.name } });
    await page.goto("/bots/bundle-browser-private");
    const avatar = page.locator('[data-bot-avatar="bundle-browser-private"] img.pet-atlas').first();
    await expect(avatar).toHaveJSProperty("naturalWidth", 1536);
  }
  expect((await pool.query("SELECT id,revision,status FROM pet_catalog ORDER BY id")).rows).toEqual(before);
  expect((await page.request.patch(endpoint, { headers: { origin }, data: { mode: "off", appearance: "moss", catalogId: null, motion: "still" } })).ok()).toBe(true);
  expect(await (await page.request.get(endpoint)).json()).toMatchObject({ enabled: false, preference: { mode: "off", motion: "still" } });
});
