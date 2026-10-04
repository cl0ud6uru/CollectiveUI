import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { mkdir } from "node:fs/promises";
import { hashPassword } from "../../src/lib/auth/password";
import { sealAppSecret } from "../../src/lib/llm/secrets";
import { send } from "./helpers";

test.skip(process.env.DELEGATION_BROWSER !== "1", "Requires isolated local mock installation");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const password = "Synthetic-delegation-browser!42";
const screenshots = "/tmp/collective-delegation-screenshots";
const owner = "task-browser-owner", receiver = "taskBrowserReceiver", assigner = "taskBrowserAssigner", app = "task-browser-model";
let homeId: string, originId: string, taskId: string;
async function login(page: Page, username = "task-fixture") {
  await page.goto("/login");
  await page.getByLabel("Local username or email").fill(username);
  await page.getByLabel("Local password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in with local account" }).click();
  await page.waitForURL("/");
}
test.beforeAll(async () => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/collective_delegation_browser_test") throw new Error("Named disposable delegation browser DB required");
  const hash = await hashPassword(password);
  await pool.query("DELETE FROM users WHERE id IN ('task-browser-owner','task-browser-other')");
  await pool.query("DELETE FROM ai_apps WHERE id=$1", [app]);
  for (const [id, username] of [[owner, "task-fixture"], ["task-browser-other", "task-other"]]) {
    await pool.query("INSERT INTO users(id,upn,name,identity_realm,auth_source) VALUES ($1,$2,'Task fixture','local','local')", [id, `local:${username}`]);
    await pool.query("INSERT INTO local_credentials(user_id,username,password_hash,must_change_password) VALUES ($1,$2,$3,false)", [id, username, hash]);
    await pool.query("INSERT INTO local_login_aliases(login,user_id) VALUES ($1,$2)", [username, id]);
  }
  await pool.query("INSERT INTO ai_apps(id,name,provider,model,base_url,api_key_enc,supports_tools) VALUES ($1,'Local delegation model','openai','mock-gpt','http://127.0.0.1:4067/v1',$2,true)", [app, sealAppSecret(app, "local-mock-only")]);
  await pool.query("INSERT INTO bots(id,owner_id,name,app_id,visibility) VALUES ($1,$3,'Assigner',$4,'org'),($2,$3,'Receiver',$4,'org')", [assigner, receiver, owner, app]);
  await pool.query("INSERT INTO bot_delegates(bot_id,delegate_bot_id) VALUES ($1,$2)", [assigner, receiver]);
  await mkdir(screenshots, { recursive: true });
});
test.afterAll(async () => { await pool.end(); });
test.describe.configure({ mode: "serial" });

test("parent links to receiving task, history/activity include it, and home stays unchanged", async ({ page }) => {
  await login(page);
  await page.goto(`/?bot=${receiver}`);
  await page.waitForURL(/\/c\//); homeId = page.url().split("/c/")[1];
  await send(page, "This is my receiver home greeting");
  await expect(page.getByRole("main").getByText('You said: "This is my receiver home greeting"', { exact: true })).toBeVisible();
  const before = (await pool.query("SELECT current_leaf_id FROM conversations WHERE id=$1", [homeId])).rows[0];
  await page.goto(`/?bot=${assigner}`);
  await page.waitForURL(/\/c\//); originId = page.url().split("/c/")[1];
  await send(page, "delegate explain cats");
  await expect.poll(async () => (await pool.query("SELECT child_conversation_id FROM delegated_tasks WHERE origin_conversation_id=$1 AND returned_at IS NOT NULL", [originId])).rows.length).toBe(1);
  taskId = (await pool.query("SELECT child_conversation_id FROM delegated_tasks WHERE origin_conversation_id=$1", [originId])).rows[0].child_conversation_id;
  const steps = page.getByRole("button", { name: /Worked for|1 steps/ }).first();
  if (await steps.isVisible()) await steps.click();
  await expect(page.getByRole("link", { name: "Open Receiver’s task" })).toBeVisible();
  await page.getByRole("link", { name: "Open Receiver’s task" }).click();
  await expect(page.getByRole("heading", { name: "Receiver · Delegated task" })).toBeVisible();
  await expect(page.getByText("Assignment from Assigner", { exact: true })).toBeVisible();
  await expect(page.getByText("Result returned to Assigner", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Share|Regenerate|Edit message/ })).toHaveCount(0);
  await expect(page.getByRole("main").getByText(/You said: "explain cats"/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Receiver · Delegated task" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Originating chat" })).toHaveAttribute("href", `/c/${originId}`);
  await page.screenshot({ path: `${screenshots}/completed-desktop.png`, fullPage: true });
  const response = await page.request.post("/api/chat", { data: { conversationId: taskId, message: { id: "tamperAttempt123", role: "user", parts: [{ type: "text", text: "Run again" }] } } });
  expect(response.status()).toBe(409);
  await page.goto(`/?bot=${receiver}`);
  await expect(page).toHaveURL(new RegExp(`/c/${homeId}$`));
  await expect(page.getByRole("main").getByText('You said: "This is my receiver home greeting"', { exact: true })).toBeVisible();
  expect((await pool.query("SELECT current_leaf_id FROM conversations WHERE id=$1", [homeId])).rows[0]).toEqual(before);
  await page.getByRole("button", { name: "Show bot details" }).click();
  const activity = page.getByRole("complementary", { name: "Receiver activity and outputs" });
  await expect(activity.getByRole("link", { name: /explain cats.*Delegated task/ })).toBeVisible();
  await page.goto(`/bots/${receiver}/chats`);
  await expect(page.getByRole("main").getByRole("link", { name: "explain cats Delegated task" })).toBeVisible();
});

test("shows real receiver work, reloads live task, stops it, and fits mobile", async ({ page, context }) => {
  await login(page);
  await page.goto(`/c/${originId}`);
  await send(page, "delegate [slow] describe a careful plan for cats");
  await expect.poll(async () => (await pool.query("SELECT child_conversation_id FROM delegated_tasks d JOIN agent_runs r ON r.id=d.child_run_id WHERE d.origin_conversation_id=$1 AND r.status='running'", [originId])).rows.length, { timeout: 30000 }).toBe(1);
  const child = (await pool.query("SELECT child_conversation_id FROM delegated_tasks d JOIN agent_runs r ON r.id=d.child_run_id WHERE d.origin_conversation_id=$1 AND r.status='running'", [originId])).rows[0].child_conversation_id;
  const receiverLink = page.locator(`nav a[href="/?bot=${receiver}"]`);
  await expect(receiverLink).toContainText("Working", { timeout: 12000 });
  const taskPage = await context.newPage();
  await taskPage.goto(`/c/${child}`);
  await expect(taskPage.getByRole("heading", { name: "Receiver · Delegated task" })).toBeVisible();
  await expect(taskPage.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await taskPage.reload();
  await expect(taskPage.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await taskPage.screenshot({ path: `${screenshots}/working-desktop.png`, fullPage: true });
  await taskPage.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(taskPage.getByText("Stopped", { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(taskPage.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expect.poll(async () => (await pool.query("SELECT status FROM agent_runs WHERE conversation_id=$1", [child])).rows[0]?.status).toBe("cancelled");
  await taskPage.setViewportSize({ width: 390, height: 844 });
  await taskPage.reload();
  await expect(taskPage.getByRole("heading", { name: "Receiver · Delegated task" })).toBeVisible();
  expect(await taskPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await taskPage.screenshot({ path: `${screenshots}/stopped-mobile.png`, fullPage: true });
  await taskPage.close();
});

test("another account cannot read or stream the private task", async ({ page }) => {
  await login(page, "task-other");
  expect((await page.request.get(`/api/chat/${taskId}`)).status()).toBe(404);
  expect((await page.request.get(`/api/chat/${taskId}/stream`)).status()).toBe(404);
  expect((await page.request.post(`/api/chat/${taskId}/stop`)).status()).toBe(404);
});
