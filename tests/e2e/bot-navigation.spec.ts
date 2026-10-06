import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { hashPassword } from "../../src/lib/auth/password";
import type { ConversationSummary } from "../../src/components/chat/types";

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
  await pool.query("INSERT INTO bot_pet_defaults(bot_id,appearance,catalog_id) VALUES('navA','catalog','builtin-the-queen-v2'),('navB','catalog','builtin-hermes-v2'),('navC','ember',null)");
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

test("large rosters show pins plus five others, keep the moved and active rows, and link to all bots", async ({ page }) => {
  for (const [id, name] of [["navD", "Delta"], ["navE", "Echo"], ["navF", "Foxtrot"], ["navG", "Golf"]])
    await pool.query("INSERT INTO bots(id,owner_id,name,visibility) VALUES($1,'navigation-admin',$2,'org')", [id, name]);
  try {
    await pool.query("UPDATE users SET prefs=$1 WHERE id='navigation-admin'", [JSON.stringify({ botOrder: ["navA", "navB", "navC", "navD", "navE", "navF", "navG"] })]);
    await pool.query("INSERT INTO user_bot_prefs(user_id,bot_id,pinned) VALUES('navigation-admin','navG',true)");
    await login(page);
    // Six unpinned bots: the sixth (Foxtrot) waits behind "See all"; the pinned Golf is always shown.
    await expect.poll(() => order(page)).toEqual(["navA", "navB", "navC", "navD", "navE", "navG"]);
    await expect(nav(page).getByRole("link", { name: "See all", exact: true })).toHaveAttribute("href", "/bots");
    // Moving the fifth row down crosses the limit; the moved row stays mounted and keeps focus.
    await nav(page).getByRole("button", { name: "Reorder Echo", exact: true }).focus();
    await page.keyboard.press("Enter");
    const down = page.getByRole("menuitem", { name: "Move down", exact: true });
    await down.focus(); await page.keyboard.press("Enter");
    await expect(nav(page).getByRole("button", { name: "Echo options", exact: true })).toBeFocused();
    await expect(nav(page).getByRole("status")).toHaveText("Moved Echo after Foxtrot");
    await expect.poll(() => order(page)).toEqual(["navA", "navB", "navC", "navD", "navF", "navE", "navG"]);
    // Moves continue to cross pinned entries without losing focus.
    await nav(page).getByRole("button", { name: "Echo options", exact: true }).press("Enter");
    await down.focus(); await page.keyboard.press("Enter");
    await expect(nav(page).getByRole("button", { name: "Echo options", exact: true })).toBeFocused();
    await expect.poll(() => order(page)).toEqual(["navA", "navB", "navC", "navD", "navF", "navG", "navE"]);
    await expect(nav(page).locator('[data-navigation-bot="navG"] [aria-label="Pinned"]')).toHaveCount(1);
    // After reload the limit applies again; opening Echo keeps it visible as the active bot.
    await page.reload();
    await expect.poll(() => order(page)).toEqual(["navA", "navB", "navC", "navD", "navF", "navG"]);
    await page.goto("/?bot=navE");
    await page.waitForURL(/\/c\//);
    await expect.poll(() => order(page)).toEqual(["navA", "navB", "navC", "navD", "navF", "navG", "navE"]);
    await expect(nav(page).locator('[data-navigation-bot="navE"] a[aria-current="page"]')).toHaveCount(1);
  } finally {
    await pool.query("DELETE FROM conversations WHERE bot_id IN ('navD','navE','navF','navG')");
    await pool.query("DELETE FROM bots WHERE id IN ('navD','navE','navF','navG')");
  }
});

const rail = (page: Page) => page.getByRole("navigation", { name: "Collapsed sidebar" });
async function collapse(page: Page) {
  await page.getByRole("button", { name: "Close sidebar", exact: true }).click();
  await expect(rail(page)).toBeVisible();
}
async function expectAccessible(page: Page, selector: string) {
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  const violations = await page.evaluate(async selector => {
    const axe = (window as unknown as { axe: typeof import("axe-core") }).axe;
    const result = await axe.run(document.querySelector(selector)!, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
    return result.violations.map(violation => ({ id: violation.id, nodes: violation.nodes.map(node => node.target) }));
  }, selector);
  expect(violations).toEqual([]);
}

test("collapsed rail uses selected avatars, persists selection and has keyboard labels and reachable bottom navigation", async ({ page }) => {
  // Shared bot identities retain their configured default; a private bot permits this viewer's personal choice.
  await pool.query("UPDATE bots SET visibility='private' WHERE id='navA'");
  await pool.query("INSERT INTO bot_pets(user_id,bot_id,enabled,mode,appearance,motion) VALUES('navigation-admin','navA',true,'personal','ember','still') ON CONFLICT(user_id,bot_id) DO UPDATE SET enabled=true, mode='personal', appearance='ember', motion='still'");
  await login(page);
  await page.goto("/?bot=navA"); await page.waitForURL(/\/c\//);
  await collapse(page);
  expect((await rail(page).boundingBox())!.width).toBe(72);
  const alpha = rail(page).locator('[data-rail-bot="navA"]');
  await expect(alpha).toHaveAttribute("aria-current", "page");
  await expect(alpha.locator('[data-pet-appearance="ember"]')).toHaveCount(1);
  await expect(alpha.locator("[data-rail-unread],[data-rail-working],[data-rail-attention]")).toHaveCount(0);
  await alpha.focus();
  await expect(page.getByRole("tooltip")).toContainText("Alpha");
  await expect(page.getByRole("tooltip")).toContainText("Idle");
  if (process.env.RAIL_SCREENSHOT_DIR) {
    await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
    await page.screenshot({ path: `${process.env.RAIL_SCREENSHOT_DIR}/rail-tooltip.png`, animations: "disabled" });
  }
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(rail(page).locator('[data-rail-bot="navA"]')).toHaveAttribute("aria-current", "page");
  await rail(page).getByRole("button", { name: "Open sidebar", exact: true }).press("Enter");
  await expect(page.getByRole("button", { name: "Close sidebar", exact: true })).toBeFocused();
  await expect(nav(page).locator('[data-navigation-bot="navA"] a[aria-current="page"]')).toHaveCount(1);
  await collapse(page);
  await rail(page).getByRole("link", { name: "Settings", exact: true }).click();
  await page.waitForURL("/settings");
  await expect(rail(page).getByRole("link", { name: "Settings", exact: true })).toHaveAttribute("aria-current", "page");
  await rail(page).getByRole("link", { name: "Hermes", exact: true }).press("Enter");
  await page.waitForURL("/hermes");
  await expect(rail(page).getByRole("link", { name: "Hermes", exact: true })).toHaveAttribute("aria-current", "page");
  await rail(page).getByRole("button", { name: "Open sidebar", exact: true }).press("Enter");
  await expect(page.getByRole("navigation").getByRole("link", { name: "Hermes", exact: true })).toHaveClass(/(?:^|\s)bg-hover(?:\s|$)/);
});

test("overflow keeps saved order, searches and selects bots, restores focus on Escape and filters revoked access", async ({ page }) => {
  const extra = [["railD", "Delta"], ["railE", "Echo"], ["railF", "Foxtrot"], ["railG", "Golf"], ["railH", "Hotel"]];
  for (const [id, name] of extra) await pool.query("INSERT INTO bots(id,owner_id,name,visibility) VALUES($1,'navigation-admin',$2,'org')", [id, name]);
  try {
    await pool.query("UPDATE users SET prefs=$1 WHERE id='navigation-member'", [JSON.stringify({ botOrder: ["navC", "navA", "navB", ...extra.map(([id]) => id)] })]);
    await pool.query("INSERT INTO user_bot_prefs(user_id,bot_id,pinned) VALUES('navigation-member','railH',true)");
    await login(page, "member"); await collapse(page);
    await expect(rail(page).locator("[data-rail-bot]")).toHaveCount(6);
    const more = rail(page).getByRole("button", { name: /^All bots/ });
    await more.press("Enter");
    const popover = page.getByRole("dialog", { name: "All bots" });
    await expect(popover.getByRole("textbox", { name: "Find a bot" })).toBeFocused();
    await expectAccessible(page, '[role="dialog"][aria-label="All bots"]');
    if (process.env.RAIL_SCREENSHOT_DIR) {
      await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
      await page.screenshot({ path: `${process.env.RAIL_SCREENSHOT_DIR}/rail-overflow.png`, animations: "disabled" });
    }
    expect(await popover.locator('[aria-label="All bot results"] > a').evaluateAll(links => links.map(link => link.getAttribute("href")))).toEqual(["navC", "navA", "navB", ...extra.map(([id]) => id)].map(id => `/?bot=${id}`));
    await popover.getByRole("textbox").fill("nothing matches");
    await expect(popover.getByRole("status")).toHaveText("No bots found");
    await page.keyboard.press("Escape"); await expect(more).toBeFocused();
    await more.click(); await popover.getByRole("textbox").fill("Golf");
    await popover.getByRole("link", { name: "Golf Idle" }).click();
    await page.waitForURL(/\/c\//);
    await expect(rail(page).locator('[data-rail-bot="railG"]')).toHaveAttribute("aria-current", "page");
    await rail(page).getByRole("button", { name: /^All bots/ }).click();
    await expect(popover.getByRole("textbox")).toHaveValue("");
    await page.keyboard.press("Escape");
    await pool.query("UPDATE bots SET visibility='private' WHERE id='railG'");
    await page.goto("/bots");
    await expect(rail(page).locator('[data-rail-bot="railG"]')).toHaveCount(0);
    await rail(page).getByRole("button", { name: /^All bots/ }).click();
    await expect(popover.getByRole("link", { name: /Golf/ })).toHaveCount(0);
    await expect(popover.getByRole("link", { name: "Manage bots" })).toHaveAttribute("href", "/bots");
  } finally {
    await pool.query("DELETE FROM conversations WHERE bot_id = ANY($1)", [extra.map(([id]) => id)]);
    await pool.query("DELETE FROM bots WHERE id = ANY($1)", [extra.map(([id]) => id)]);
  }
});

test("confirmed activity, themes, reduced motion and a short rail remain accessible; mobile retains the expanded drawer", async ({ page }) => {
  await login(page); await collapse(page);
  const task = (botId: string, status: NonNullable<ConversationSummary["taskActivity"]>["status"], unread: boolean): ConversationSummary => ({ id: `rail-task-${botId}`, title: "Synthetic task", botId, appId: null, folderId: null, pinned: false, source: "delegation", updatedAt: new Date().toISOString(), taskActivity: { status, unread } });
  await page.route("**/api/chat/recent-tasks", route => route.fulfill({ json: [task("navA", "running", false), task("navB", "succeeded", true), task("navC", "failed", true)] }));
  await page.evaluate(() => window.dispatchEvent(new Event("recent-tasks-changed")));
  await expect(rail(page).locator('[data-rail-bot="navA"] [data-rail-working]')).toHaveCount(1);
  await expect(rail(page).locator('[data-rail-bot="navB"] [data-rail-unread]')).toHaveCount(1);
  await expect(rail(page).locator('[data-rail-bot="navC"] [data-rail-attention]')).toHaveCount(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(rail(page).locator('[data-rail-working]')).toHaveCSS("animation-name", "none");
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => { localStorage.setItem("theme", theme); }, theme);
    await page.reload();
    await expect(page.locator("html")).toHaveClass(new RegExp(theme));
    await expect(rail(page)).toBeVisible();
    await expectAccessible(page, 'nav[aria-label="Collapsed sidebar"]');
    if (process.env.RAIL_SCREENSHOT_DIR) {
      await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
      await page.screenshot({ path: `${process.env.RAIL_SCREENSHOT_DIR}/rail-${theme}.png`, animations: "disabled" });
    }
  }
  await page.setViewportSize({ width: 1000, height: 550 });
  await expect(rail(page).getByRole("link", { name: "Settings", exact: true })).toBeInViewport();
  await expect(rail(page).getByRole("button", { name: "Open sidebar", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await rail(page).getByRole("button", { name: /^All bots/ }).click();
  await expect(page.getByRole("dialog", { name: "All bots" })).toBeInViewport();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1000, height: 400 });
  await rail(page).locator('[data-rail-bot="navA"]').scrollIntoViewIfNeeded();
  await expect(rail(page).locator('[data-rail-bot="navA"]')).toBeInViewport();
  await rail(page).getByRole("button", { name: /^All bots/ }).scrollIntoViewIfNeeded();
  await expect(rail(page).getByRole("button", { name: /^All bots/ })).toBeInViewport();
  await rail(page).getByRole("button", { name: /^All bots/ }).click();
  await expect(page.getByRole("dialog", { name: "All bots" }).getByRole("textbox")).toBeInViewport();
  await page.keyboard.press("Escape");
  await rail(page).getByRole("link", { name: "Settings", exact: true }).scrollIntoViewIfNeeded();
  await expect(rail(page).getByRole("link", { name: "Settings", exact: true })).toBeInViewport();
  await rail(page).getByRole("button", { name: "Open sidebar", exact: true }).scrollIntoViewIfNeeded();
  await expect(rail(page).getByRole("button", { name: "Open sidebar", exact: true })).toBeInViewport();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(rail(page)).toBeHidden();
  await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
  await expect(nav(page)).toBeVisible();
  await expect(nav(page).locator('[data-navigation-bot="navA"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.RAIL_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.RAIL_SCREENSHOT_DIR}/mobile-drawer.png`, animations: "disabled" });
});
