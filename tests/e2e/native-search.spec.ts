import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { hashPassword } from "../../src/lib/auth/password";
import { sealAppSecret } from "../../src/lib/llm/secrets";

test.skip(process.env.NATIVE_SEARCH_FIXTURES !== "1", "Disposable fixture worker required; never run against live credentials");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const password = "Synthetic-native-search!42";
async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Local username or email").fill("search-admin");
  await page.getByLabel("Local password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in with local account" }).click();
  await page.waitForURL("/");
}
async function searchControl(page: Page) {
  const summary = page.locator("summary").filter({ hasText: "OpenAI native search" });
  await expect(summary).not.toContainText("Loading");
  if (!(await page.getByLabel("OpenAI native search", { exact: true }).isVisible())) await summary.click();
  return page.getByLabel("OpenAI native search", { exact: true });
}
async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.waitForURL(/\/c\//);
}
test.beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/collective_native_search_test") throw new Error("Disposable native-search fixture database required");
  await pool.query("DELETE FROM users WHERE id='searchAdmin'");
  await pool.query("DELETE FROM ai_apps WHERE id IN ('searchApp','searchCustom')");
  await pool.query("DELETE FROM auth_throttle");
  await pool.query("INSERT INTO users(id,upn,name,identity_realm,auth_source,is_admin,prefs) VALUES ('searchAdmin','local:searchAdmin','Alex','local','local',true,'{\"memoryEnabled\":false}')");
  await pool.query("INSERT INTO local_credentials(user_id,username,password_hash,must_change_password) VALUES ('searchAdmin','search-admin',$1,false)", [await hashPassword(password)]);
  await pool.query("INSERT INTO local_login_aliases(login,user_id) VALUES ('search-admin','searchAdmin')");
  await pool.query("INSERT INTO ai_apps(id,name,provider,model,is_public,supports_tools,api_key_enc) VALUES ('searchApp','OpenAI API fixture','openai','gpt-4.1',true,true,$1)", [sealAppSecret("searchApp", "fixture-never-live")]);
  await pool.query("INSERT INTO ai_apps(id,name,provider,model,base_url,is_public,supports_tools) VALUES ('searchCustom','Custom endpoint fixture','openai','gpt-4.1','https://custom.invalid/v1',true,true)");
  await pool.query("INSERT INTO bots(id,owner_id,name,app_id,visibility,description) VALUES ('searchBot','searchAdmin','Search Assistant','searchApp','org','Research with cited web sources.')");
  await pool.query("INSERT INTO bot_tools(bot_id,tool_key,approval) VALUES ('searchBot','openai_web_search','auto')");
  const settings = { disabledTools: [], enforcedApproval: [], fetchAllowlist: [], webSearch: { provider: "none" }, maxStepsCap: 5, botCreation: "everyone", nativeSearch: { enabled: true, maxCalls: 2, allowedDomains: ["example.com"] } };
  await pool.query("INSERT INTO settings(key,value) VALUES ('tools',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [settings]);
  await pool.query("INSERT INTO settings(key,value) VALUES ('branding','{\"appName\":\"CollectiveUI\",\"welcomeText\":\"What can I help with?\",\"logoEmoji\":\"\",\"defaultAppId\":\"searchApp\"}') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
});
test.afterAll(async () => { await pool.end(); });

test("direct search, repeat, cancellation, navigation, saved citations and sharing", async ({ page }) => {
  await login(page);
  const select = await searchControl(page);
  await expect(select).toHaveValue("off");
  await select.selectOption("auto");
  await page.screenshot({ path: "/tmp/native-search-chat-toggle.png", fullPage: true });
  await send(page, "Find fixture weather");
  await expect(page.getByText("OpenAI search: 1 observed call", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop generating", exact: true })).toHaveCount(0);
  await expect(await searchControl(page)).toHaveValue("auto");
  await expect(page.locator('a[href="https://example.com/weather"]').filter({ hasText: "Fixture weather" })).toBeVisible();
  const chat = page.url();
  await page.screenshot({ path: "/tmp/native-search-citations.png", fullPage: true });
  await page.reload();
  await expect(page.locator('a[href="https://example.com/weather"]').filter({ hasText: "Fixture weather" })).toBeVisible();
  await (await searchControl(page)).selectOption("off");
  await page.reload();
  await expect(await searchControl(page)).toHaveValue("off");
  await (await searchControl(page)).selectOption("auto");
  await send(page, "Repeat fixture weather");
  await expect(page.getByText("OpenAI search: 1 observed call", { exact: false })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Stop generating", exact: true })).toHaveCount(0);
  await send(page, "slow fixture weather");
  await expect.poll(async () => Number((await pool.query("SELECT count(*) FROM usage_events WHERE user_id='searchAdmin' AND hosted_search_calls=1")).rows[0].count)).toBeGreaterThanOrEqual(3);
  await page.getByRole("button", { name: "Stop generating", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop generating", exact: true })).toHaveCount(0);
  await page.goto("/settings"); await page.goBack();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeEnabled();
  await expect(page.locator('a[href="https://example.com/weather"]').filter({ hasText: "Fixture weather" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Share chat", exact: true }).click();
  await page.getByRole("button", { name: "Create link", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy link", exact: true })).toBeVisible();
  const link = await page.getByRole("dialog").locator("span").filter({ hasText: /http.*\/share\// }).innerText();
  await page.goto(link);
  await expect(page.locator('a[href="https://example.com/weather"]').filter({ hasText: "Fixture weather" }).first()).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveCount(0);
  await page.screenshot({ path: "/tmp/native-search-shared.png", fullPage: true });
  await page.goto(chat);
  const id = new URL(chat).pathname.split("/").at(-1);
  const usage = (await pool.query("SELECT sum(hosted_search_calls)::int AS calls,sum(search_tool_cost_estimate_micros)::int AS cost FROM usage_events WHERE conversation_id=$1", [id])).rows[0];
  expect(usage.calls).toBeGreaterThanOrEqual(2); expect(usage.cost).toBe(usage.calls * 10000);
});

test("admin controls, bot default, custom endpoint reason and ambiguous settings fail closed", async ({ page }) => {
  await login(page);
  await page.goto("/admin/tools");
  await expect(page.getByLabel("Allow OpenAI native search", { exact: true })).toBeChecked();
  await page.getByLabel("Maximum hosted search calls per reply", { exact: true }).fill("3");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/native-search-admin.png", fullPage: true });
  await page.goto("/?bot=searchBot");
  await expect(await searchControl(page)).toHaveValue("auto");
  await (await searchControl(page)).selectOption("off");
  await page.reload();
  await expect(await searchControl(page)).toHaveValue("off");
  await send(page, "Fixture answer before an ambiguous save");
  await expect(page.getByRole("button", { name: "Regenerate", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit message", exact: true }).click();
  await page.route("**/api/chat/native-search", async route => {
    if (route.request().method() !== "PATCH") return route.continue();
    const committed = await route.fetch();
    expect(committed.ok()).toBe(true);
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Fixture lost save response" }) });
  });
  await (await searchControl(page)).selectOption("auto");
  await expect(page.getByText(/Reload to verify search settings before sending/)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Regenerate", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.unroute("**/api/chat/native-search");
  await page.reload();
  await expect(await searchControl(page)).toHaveValue("auto");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeEnabled();
  await page.goto("/?app=searchCustom");
  await searchControl(page);
  await expect(page.getByText("Native search is unavailable on custom endpoints.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("OpenAI native search", { exact: true }).locator('option[value="auto"]')).toHaveAttribute("disabled", "");
  await page.route("**/api/chat/native-search?*", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Fixture settings failure" }) }));
  await page.goto("/?app=searchApp");
  await searchControl(page);
  await expect(page.getByText(/Reload to verify search settings before sending/)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeDisabled();
});
