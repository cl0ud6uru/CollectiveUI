import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { createServer } from "node:http";
import { login, openBot, send } from "./helpers";

test("reduced motion stops roster, avatar and grouped tool-step animations during real work", async ({ page }) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const botId = `motion${Date.now()}`;
  const server = createServer((req, res) => setTimeout(() => { res.setHeader("content-type", "text/plain"); res.end("Motion test fixture"); }, req.url === "/first" ? 50 : 4000));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const previous = (await pool.query("SELECT value FROM settings WHERE key='tools'")).rows[0].value;
  try {
    const owner = (await pool.query("SELECT id FROM users WHERE upn='alice@corp.local'")).rows[0].id;
    const app = (await pool.query("SELECT id FROM ai_apps WHERE name='Mock GPT'")).rows[0].id;
    await pool.query("INSERT INTO bots(id,owner_id,name,avatar,app_id,visibility) VALUES($1,$2,'Motion Partner','blob:circle:teal',$3,'org')", [botId, owner, app]);
    await pool.query("INSERT INTO bot_tools(bot_id,tool_key,approval) VALUES($1,'fetch_url','auto')", [botId]);
    await pool.query("UPDATE settings SET value=$1::jsonb WHERE key='tools'", [JSON.stringify({ ...previous, fetchAllowlist: ["127.0.0.1"] })]);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await login(page, "alice"); await openBot(page, "Motion Partner");
    await send(page, `[tool:fetch_url {"url":"http://127.0.0.1:${port}/first"}] [tool:fetch_url {"url":"http://127.0.0.1:${port}/second"}]`);
    const steps = page.getByRole("button", { name: /^Working/ }).first();
    await expect(steps).toBeVisible({ timeout: 30_000 });
    await expect(steps.locator("svg").first()).toHaveCSS("animation-name", "none");
    await expect(steps.locator("span").first()).toHaveCSS("animation-name", "none");
    await expect(page.locator("header .blob-body")).toHaveCSS("animation-name", "none");
    await expect(page.locator(`nav a[href="/?bot=${botId}"] [class*="motion-safe:animate-pulse"]`)).toHaveCSS("animation-name", "none");
    await expect(page.getByLabel("Stop generating")).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await pool.query("UPDATE settings SET value=$1::jsonb WHERE key='tools'", [JSON.stringify(previous)]);
    await pool.query("DELETE FROM conversations WHERE bot_id=$1", [botId]);
    await pool.query("DELETE FROM bots WHERE id=$1", [botId]);
    await pool.end();
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
