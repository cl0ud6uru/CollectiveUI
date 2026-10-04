import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { hashPassword } from "../../src/lib/auth/password";

test.skip(process.env.BOT_NAVIGATION_BROWSER !== "1", "Requires disposable local navigation fixtures");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const password = "Synthetic-navigation!42";
const nav = (page: Page) => page.locator('nav:visible [aria-label="Bot navigation"]');
const order = (page: Page) => nav(page).locator("[data-navigation-bot]").evaluateAll(rows => rows.map(row => row.getAttribute("data-navigation-bot")));
async function login(page: Page, role = "admin") {
  await page.goto("/login");
  await page.getByLabel("Local username or email").fill(`navigation-${role}`);
  await page.getByLabel("Local password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in with local account" }).click();
  await page.waitForURL("/");
  await page.goto("/bots");
}
test.beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/collective_navigation_test") throw new Error("Disposable navigation fixture database required");
  await pool.query("DELETE FROM users WHERE id IN ('navigation-admin','navigation-member')");
  const hash = await hashPassword(password);
  for (const role of ["admin", "member"]) {
    const id = `navigation-${role}`;
    await pool.query("INSERT INTO users(id,upn,name,identity_realm,auth_source,is_admin) VALUES($1,$2,$1,'local','local',$3)", [id, `local:${id}`, role === "admin"]);
    await pool.query("INSERT INTO local_credentials(user_id,username,password_hash,must_change_password) VALUES($1,$1,$2,false)", [id, hash]);
    await pool.query("INSERT INTO local_login_aliases(login,user_id) VALUES($1,$1)", [id]);
  }
  for (const [id, name] of [["navA", "Alpha"], ["navB", "Bravo"], ["navC", "Charlie"]])
    await pool.query("INSERT INTO bots(id,owner_id,name,visibility) VALUES($1,'navigation-admin',$2,'org')", [id, name]);
});
test.beforeEach(async () => {
  await pool.query("DELETE FROM auth_throttle");
  await pool.query("UPDATE users SET prefs='{}' WHERE id IN ('navigation-admin','navigation-member')");
  await pool.query("DELETE FROM user_bot_prefs WHERE user_id IN ('navigation-admin','navigation-member')");
  await pool.query("UPDATE bots SET name=CASE id WHEN 'navA' THEN 'Alpha' WHEN 'navB' THEN 'Bravo' ELSE 'Charlie' END, visibility='org' WHERE id IN ('navA','navB','navC')");
});
test.afterAll(async () => { await pool.end(); });

test("directory pins synchronize immediately; keyboard moves retain focus and survive navigation, activity and reload", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "Pin Charlie", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unpin Charlie", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Unpin Charlie", exact: true })).toBeEnabled();
  await expect.poll(() => order(page)).toEqual(["navC", "navA", "navB"]);
  await nav(page).getByRole("button", { name: "Charlie options", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Move down", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(nav(page).getByRole("button", { name: "Charlie options", exact: true })).toBeFocused();
  await expect(nav(page).getByRole("status")).toHaveText("Moved Charlie after Alpha");
  await expect.poll(() => order(page)).toEqual(["navA", "navC", "navB"]);
  await page.reload();
  await expect.poll(() => order(page)).toEqual(["navA", "navC", "navB"]);
  await pool.query("UPDATE bots SET name='Aardvark activity update' WHERE id='navB'");
  await page.goto("/settings"); await page.goto("/bots");
  await expect(nav(page).getByText("Aardvark activity update", { exact: true })).toBeVisible();
  await expect.poll(() => order(page)).toEqual(["navA", "navC", "navB"]);
  await page.getByRole("button", { name: "Unpin Charlie", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pin Charlie", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(nav(page).locator('[data-navigation-bot="navC"] [aria-label="Pinned"]')).toHaveCount(0);
});

test("drag insertion persists and cancelling a drag leaves the saved arrangement intact", async ({ page }) => {
  await login(page);
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await nav(page).getByRole("button", { name: "Reorder Charlie" }).dispatchEvent("dragstart", { dataTransfer });
  const target = nav(page).locator('[data-navigation-bot="navA"]');
  const bounds = (await target.boundingBox())!;
  await target.dispatchEvent("dragover", { dataTransfer, clientY: bounds.y + 1 });
  await expect(target).toHaveClass(/before:border-accent/);
  await nav(page).getByRole("button", { name: "Reorder Charlie" }).dispatchEvent("dragend");
  await expect(target).not.toHaveClass(/before:border-accent/);
  await expect.poll(() => order(page)).toEqual(["navA", "navB", "navC"]);
  await nav(page).getByRole("button", { name: "Reorder Charlie" }).dragTo(target, { targetPosition: { x: 50, y: 2 } });
  await expect(nav(page).getByRole("status")).toHaveText("Moved Charlie before Alpha");
  await page.reload();
  await expect.poll(() => order(page)).toEqual(["navC", "navA", "navB"]);
});

test("mobile move actions work without dragging and preserve the drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
  await nav(page).getByRole("button", { name: "Reorder Bravo" }).click();
  await page.getByRole("menuitem", { name: "Move up", exact: true }).click();
  await expect(nav(page).getByRole("button", { name: "Bravo options", exact: true })).toBeFocused();
  await expect(nav(page)).toBeVisible();
  await expect.poll(() => order(page)).toEqual(["navB", "navA", "navC"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/collective-navigation-mobile.png" });
});

test("pending saves synchronize surfaces, prevent duplicate actions, and roll back a failed save", async ({ page }) => {
  await login(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/bots", async route => {
    if (route.request().method() === "POST" && route.request().postData()?.includes('"kind":"preference"')) {
      await gate; await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Pin Charlie", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unpin Charlie", exact: true })).toBeDisabled();
  await expect.poll(() => order(page)).toEqual(["navC", "navA", "navB"]);
  await expect(page.getByRole("button", { name: "Pin Bravo", exact: true })).toBeDisabled();
  release();
  await expect(page.getByRole("button", { name: "Pin Charlie", exact: true })).toBeEnabled();
  await expect.poll(() => order(page)).toEqual(["navA", "navB", "navC"]);
  await expect(page.locator('[data-sonner-toast]')).toBeVisible();
  await page.unroute("**/bots");
  await page.reload();
  await expect(page.getByRole("button", { name: "Pin Charlie", exact: true })).toHaveAttribute("aria-pressed", "false");
});

test("ordinary users own their pins; revoked or deleted shared bots disappear despite saved references", async ({ page, browser }) => {
  await login(page, "member");
  await page.getByRole("button", { name: "Pin Charlie", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unpin Charlie", exact: true })).toBeEnabled();
  const context = await browser.newContext(); const admin = await context.newPage();
  await login(admin);
  await expect(admin.getByRole("button", { name: "Pin Charlie", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => order(admin)).toEqual(["navA", "navB", "navC"]);
  await pool.query("UPDATE bots SET visibility='private' WHERE id='navC'");
  await page.reload();
  await expect(nav(page).locator('[data-navigation-bot="navC"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Unpin Charlie", exact: true })).toHaveCount(0);
  await pool.query("DELETE FROM bots WHERE id='navC'");
  await admin.reload();
  await expect(nav(admin).locator('[data-navigation-bot="navC"]')).toHaveCount(0);
  await pool.query("INSERT INTO bots(id,owner_id,name,visibility) VALUES('navC','navigation-admin','Charlie','org')");
  await context.close();
});

test("large rosters keep the moved row and keyboard focus when crossing pinned entries", async ({ page }) => {
  for (const [id, name] of [["navD", "Delta"], ["navE", "Echo"], ["navF", "Foxtrot"], ["navG", "Golf"]])
    await pool.query("INSERT INTO bots(id,owner_id,name,visibility) VALUES($1,'navigation-admin',$2,'org')", [id, name]);
  try {
    await pool.query("UPDATE users SET prefs=$1 WHERE id='navigation-admin'", [JSON.stringify({ botOrder: ["navA", "navB", "navC", "navD", "navE", "navF", "navG"] })]);
    await pool.query("INSERT INTO user_bot_prefs(user_id,bot_id,pinned) VALUES('navigation-admin','navG',true)");
    await login(page);
    await expect(nav(page).locator("[data-navigation-bot]")).toHaveCount(7);
    await nav(page).getByRole("button", { name: "Reorder Foxtrot", exact: true }).focus();
    await page.keyboard.press("Enter");
    const down = page.getByRole("menuitem", { name: "Move down", exact: true });
    await down.focus(); await page.keyboard.press("Enter");
    await expect(nav(page).getByRole("button", { name: "Foxtrot options", exact: true })).toBeFocused();
    await expect(nav(page).getByRole("status")).toHaveText("Moved Foxtrot after Golf");
    await expect.poll(() => order(page)).toEqual(["navA", "navB", "navC", "navD", "navE", "navG", "navF"]);
    await page.reload();
    await expect(nav(page).locator("[data-navigation-bot]")).toHaveCount(7);
  } finally { await pool.query("DELETE FROM bots WHERE id IN ('navD','navE','navF','navG')"); }
});
