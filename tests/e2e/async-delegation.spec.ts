import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { mkdir } from "node:fs/promises";
import { hashPassword } from "../../src/lib/auth/password";
import { sealAppSecret } from "../../src/lib/llm/secrets";
import { send } from "./helpers";

test.skip(process.env.ASYNC_BROWSER !== "1", "Requires isolated local mock installation");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const password = "Synthetic-delegation-browser!42";
const screenshots = "/tmp/collective-coordinator-async-screenshots";
const owner = "task-browser-owner", receiver = "taskBrowserReceiver", assigner = "taskBrowserAssigner", app = "task-browser-model";
let homeId: string, originId: string;
async function login(page: Page, username = "task-fixture") {
  await page.goto("/login");
  await page.getByLabel("Local username or email").fill(username);
  await page.getByLabel("Local password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in with local account" }).click();
  await page.waitForURL(url => url.pathname === "/" || url.pathname.startsWith("/c/"));
}
test.beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/collective_coordinator_async_browser_test") throw new Error("Named disposable delegation browser DB required");
  await pool.query("DELETE FROM auth_throttle");
  const hash = await hashPassword(password);
  await pool.query("DELETE FROM users WHERE id IN ('task-browser-owner','task-browser-other')");
  await pool.query("DELETE FROM ai_apps WHERE id=$1", [app]);
  for (const [id, username] of [[owner, "task-fixture"], ["task-browser-other", "task-other"]]) {
    await pool.query("INSERT INTO users(id,upn,name,identity_realm,auth_source) VALUES ($1,$2,'Task fixture','local','local')", [id, `local:${username}`]);
    await pool.query("INSERT INTO local_credentials(user_id,username,password_hash,must_change_password) VALUES ($1,$2,$3,false)", [id, username, hash]);
    await pool.query("INSERT INTO local_login_aliases(login,user_id) VALUES ($1,$2)", [username, id]);
  }
  await pool.query("INSERT INTO ai_apps(id,name,provider,model,base_url,api_key_enc,supports_tools) VALUES ($1,'Local delegation model','openai','mock-gpt','http://127.0.0.1:4068/v1',$2,true)", [app, sealAppSecret(app, "local-mock-only")]);
  await pool.query("INSERT INTO bots(id,owner_id,name,app_id,visibility) VALUES ($1,$3,'Assigner',$4,'org'),($2,$3,'Receiver',$4,'org')", [assigner, receiver, owner, app]);
  await pool.query("UPDATE bots SET coordinator_eligible=true WHERE id=$1", [receiver]);
  await pool.query("INSERT INTO settings(key,value) VALUES ('coordinator',$1) ON CONFLICT(key) DO UPDATE SET value=$1", [JSON.stringify({ enabled: true, defaultBotId: assigner, starterBotId: null })]);
  await mkdir(screenshots, { recursive: true });
});
test.afterAll(async () => { await pool.end(); });
test.describe.configure({ mode: "serial" });

test("automatic coordinator work survives closing its parent, reconnects the child, and returns one result", async ({ page, context }) => {
  await login(page);
  await page.goto(`/?bot=${receiver}`); await page.waitForURL(/\/c\//); homeId = page.url().split("/c/")[1];
  const before = (await pool.query("SELECT current_leaf_id FROM conversations WHERE id=$1", [homeId])).rows[0];
  await page.goto(`/?bot=${assigner}`); await page.waitForURL(/\/c\//); originId = page.url().split("/c/")[1];
  await send(page, "delegate [async] [slow] explain careful durable native task handling for a curious user");
  await expect.poll(async () => (await pool.query("SELECT status FROM agent_runs WHERE conversation_id=$1", [originId])).rows[0]?.status, { timeout: 30000 }).toBe("waiting_tasks");
  await expect(page.getByText("Waiting for delegated tasks…", { exact: true })).toBeVisible();
  const task = (await pool.query("SELECT id,child_conversation_id,child_run_id,ancestry FROM delegated_tasks WHERE origin_conversation_id=$1", [originId])).rows[0];
  const recent = page.locator(`nav a[href="/c/${task.child_conversation_id}"]`);
  await expect(recent).toHaveCount(1, { timeout: 3000 });
  await expect(recent.getByRole("img", { name: "Task working", exact: true })).toBeVisible();
  const header = page.locator("main header");
  const pet = await header.locator(`[data-bot-avatar="${assigner}"]`).boundingBox();
  const pane = await header.boundingBox();
  expect(Math.abs(pet!.x + pet!.width / 2 - (pane!.x + pane!.width / 2))).toBeLessThan(1);
  await page.screenshot({ path: `${screenshots}/recent-working.png`, fullPage: true });
  expect(task.ancestry).toEqual([{ from: assigner, to: receiver, mode: "coordinator" }]);
  expect((await pool.query("SELECT * FROM bot_delegates WHERE bot_id=$1", [assigner])).rows).toHaveLength(0);
  const taskPage = await context.newPage();
  let requests = 0;
  let delayedReceipt = false;
  await taskPage.route(`**/api/chat/${task.child_conversation_id}`, async route => {
    const response = await route.fetch(); const data = await response.json();
    // Force the terminal child snapshot to arrive before its parent receipt, independent of worker speed.
    if (data.task?.status === "succeeded" && !delayedReceipt) {
      delayedReceipt = true; data.task.returnedAt = null; data.task.deliveryPending = true;
    }
    await route.fulfill({ response, json: data });
  });
  await taskPage.route(`**/api/chat/${task.child_conversation_id}/stream`, route => ++requests === 1 ? route.abort("failed") : route.continue());
  await taskPage.goto(`/c/${task.child_conversation_id}`);
  await expect(taskPage.getByRole("heading", { name: "Receiver · Delegated task" })).toBeVisible();
  await page.close();
  await expect.poll(() => requests, { timeout: 15000 }).toBeGreaterThan(1);
  await expect(taskPage.getByRole("main").getByText(/You said:/)).toBeVisible({ timeout: 30000 });
  await expect(taskPage.getByText("Completed", { exact: true })).toBeVisible({ timeout: 45000 });
  await expect(taskPage.getByText("Result returned to Assigner", { exact: true })).toBeVisible({ timeout: 15000 });
  await expect.poll(async () => (await pool.query("SELECT read_at FROM inbox_items WHERE id=$1", [`task_${task.id}`])).rows[0]?.read_at).toBeTruthy();
  expect(delayedReceipt).toBe(true);
  await expect(taskPage.getByRole("main").getByText(/durable native task handling for a curious user/).last()).toBeVisible();
  await taskPage.screenshot({ path: `${screenshots}/completed-task.png`, fullPage: true });
  await expect.poll(async () => (await pool.query("SELECT status FROM agent_runs WHERE conversation_id=$1", [originId])).rows[0]?.status, { timeout: 30000 }).toBe("succeeded");
  expect((await pool.query("SELECT id FROM inbox_items WHERE id=$1", [`task_${task.id}`])).rows).toHaveLength(1);
  expect((await pool.query("SELECT current_leaf_id FROM conversations WHERE id=$1", [homeId])).rows[0]).toEqual(before);
  await taskPage.goto(`/c/${originId}`);
  await expect(taskPage.getByLabel("Message", { exact: true })).toBeEnabled();
  await expect(taskPage.getByRole("main").getByText(/Let me know if you need anything else/)).toBeVisible();
  await taskPage.close();
});

test("parent resumes in place and Stop cancels an independent child", async ({ page }) => {
  await login(page); await page.goto(`/c/${originId}`);
  await send(page, "delegate [async] explain cats");
  await expect(page.getByRole("main").getByText(/Let me know if you need anything else/)).toHaveCount(2, { timeout: 30000 });
  await expect(page.getByLabel("Message", { exact: true })).toBeEnabled();
  await send(page, "delegate [async] [slow] a long detailed plan that must be stopped before completion");
  await expect(page.getByText("Waiting for delegated tasks…", { exact: true })).toBeVisible({ timeout: 30000 });
  await expect.poll(async () => (await pool.query("SELECT id FROM agent_runs WHERE conversation_id=$1 AND status='waiting_tasks'", [originId])).rows.length).toBe(1);
  const task = (await pool.query("SELECT d.child_conversation_id,d.child_run_id FROM delegated_tasks d JOIN agent_runs r ON r.id=d.parent_run_id WHERE d.origin_conversation_id=$1 AND r.status='waiting_tasks'", [originId])).rows[0];
  await page.getByRole("button", { name: "Stop generating", exact: true }).click();
  await expect.poll(async () => (await pool.query("SELECT status FROM agent_runs WHERE id=$1", [task.child_run_id])).rows[0]?.status).toBe("cancelled");
  await page.goto(`/c/${task.child_conversation_id}`);
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
  await expect(page.locator(`nav a[href="/c/${task.child_conversation_id}"] [data-task-indicator="stopped"]`)).toBeVisible();
  await expect(page.locator(`nav a[href="/c/${task.child_conversation_id}"] [data-task-indicator="working"]`)).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `${screenshots}/stopped-mobile.png`, fullPage: true });
});

test("a task that finishes before stream attachment loads its complete saved transcript", async ({ page }) => {
  await login(page);
  const task = (await pool.query("SELECT d.child_conversation_id,d.child_run_id FROM delegated_tasks d JOIN agent_runs r ON r.id=d.child_run_id WHERE d.user_id=$1 AND r.status='succeeded' ORDER BY d.created_at LIMIT 1", [owner])).rows[0];
  await page.route(`**/api/chat/${task.child_conversation_id}/stream`, route => route.fulfill({ status: 204 }));
  await page.goto(`/c/${task.child_conversation_id}`);
  await expect(page.getByText("Completed", { exact: true })).toBeVisible();
  await expect(page.getByRole("main").getByText(/You said:/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
});

test("a queued task attaches before a worker slot opens and receives its complete result", async ({ page, context }) => {
  await login(page); await page.goto(`/c/${originId}`);
  await send(page, "delegate [async] [slow] explain a lengthy sequence of careful verification steps for creating independent tasks while preserving the source conversation and all user permissions throughout execution");
  await expect.poll(async () => (await pool.query("SELECT r.status FROM delegated_tasks d JOIN agent_runs r ON r.id=d.child_run_id WHERE d.origin_conversation_id=$1 ORDER BY d.created_at DESC LIMIT 1", [originId])).rows[0]?.status, { timeout: 30000 }).toBe("running");
  const secondAssigner = "taskBrowserSecondAssigner";
  await pool.query("INSERT INTO bots(id,owner_id,name,app_id) VALUES ($1,$2,'Other assigner',$3)", [secondAssigner, owner, app]);
  await pool.query("INSERT INTO bot_delegates(bot_id,delegate_bot_id) VALUES ($1,$2)", [secondAssigner, receiver]);
  const other = await context.newPage(); await other.goto(`/?bot=${secondAssigner}`); await other.waitForURL(/\/c\//);
  const otherId = other.url().split("/c/")[1];
  await send(other, "delegate [async] verify the queued task");
  await expect.poll(async () => (await pool.query("SELECT status FROM agent_runs WHERE conversation_id=$1", [otherId])).rows[0]?.status, { timeout: 15000 }).toBe("waiting_tasks");
  const task = (await pool.query("SELECT d.child_conversation_id,r.status FROM delegated_tasks d JOIN agent_runs r ON r.id=d.child_run_id WHERE d.origin_conversation_id=$1", [otherId])).rows[0];
  expect(task.status).toBe("queued");
  const childPage = await context.newPage();
  const response = childPage.waitForResponse(r => r.url().endsWith(`/api/chat/${task.child_conversation_id}/stream`));
  await childPage.goto(`/c/${task.child_conversation_id}`);
  await expect(childPage.getByText("Queued", { exact: true })).toBeVisible();
  expect((await page.request.post(`/api/chat/${originId}/stop`)).ok()).toBe(true);
  expect((await response).status()).toBe(200);
  await expect(childPage.getByText("Completed", { exact: true })).toBeVisible({ timeout: 30000 });
  await expect(childPage.getByRole("main").getByText('You said: "verify the queued task"', { exact: true })).toBeVisible();
  await other.close(); await childPage.close();
});

test("recent task unread survives an early visit, parent reading, reload, and offline recovery", async ({ page, context }) => {
  await login(page); await page.goto(`/c/${originId}`);
  await send(page, "delegate [async] [slow] explain a detailed useful process for organizing a busy day and choosing the right priorities with careful review");
  let task: { id: string; child_conversation_id: string; child_run_id: string };
  await expect.poll(async () => {
    task = (await pool.query("SELECT d.id,d.child_conversation_id,d.child_run_id FROM delegated_tasks d JOIN agent_runs r ON r.id=d.child_run_id WHERE d.origin_conversation_id=$1 AND r.status='running' ORDER BY d.created_at DESC LIMIT 1", [originId])).rows[0];
    return !!task;
  }, { timeout: 30000 }).toBe(true);
  const childId = task!.child_conversation_id;
  const row = () => page.locator(`nav a[href="/c/${childId}"]`);
  await expect(row()).toHaveCount(1);
  await row().click();
  await expect(page.getByRole("heading", { name: "Receiver · Delegated task" })).toBeVisible();
  await page.getByRole("link", { name: "Originating chat", exact: true }).click();
  await page.waitForURL(`/c/${originId}`);
  await context.setOffline(true);
  await expect.poll(async () => (await pool.query("SELECT status FROM agent_runs WHERE id=$1", [task!.child_run_id])).rows[0]?.status, { timeout: 40000 }).toBe("succeeded");
  await context.setOffline(false);
  await expect(row().getByRole("img", { name: "Completed task · Unread", exact: true })).toBeVisible({ timeout: 10000 });
  await expect(row().locator('[data-task-indicator="working"]')).toHaveCount(0);
  await page.reload();
  await expect(row().getByRole("img", { name: "Completed task · Unread", exact: true })).toBeVisible();
  await expect(page.locator("main h1")).toHaveText("Assigner");
  const inboxCount = Number((await page.locator('nav a[href="/inbox"]').innerText()).replace(/\D/g, ""));
  await page.screenshot({ path: `${screenshots}/recent-unread.png`, fullPage: true });
  await expect(row()).toHaveCount(1);
  await row().click();
  await expect(page.getByText("Completed", { exact: true })).toBeVisible();
  await expect(row().locator("[data-task-indicator]")).toHaveCount(0, { timeout: 10000 });
  await expect.poll(async () => Number((await page.locator('nav a[href="/inbox"]').innerText()).replace(/\D/g, ""))).toBe(inboxCount - 1);
  await page.reload();
  await expect(page.getByText("Completed", { exact: true })).toBeVisible();
  await expect(row().locator("[data-task-indicator]")).toHaveCount(0);
  await page.screenshot({ path: `${screenshots}/recent-read.png`, fullPage: true });
});

test("a final snapshot arriving after navigation cannot mark the child read", async ({ page }) => {
  await login(page); await page.goto(`/c/${originId}`);
  await send(page, "delegate [async] [slow] explain a detailed process for reviewing results carefully before acknowledging completion and preserving the unread marker during navigation");
  let task: { id: string; child_conversation_id: string; child_run_id: string };
  await expect.poll(async () => {
    task = (await pool.query("SELECT d.id,d.child_conversation_id,d.child_run_id FROM delegated_tasks d JOIN agent_runs r ON r.id=d.child_run_id WHERE d.origin_conversation_id=$1 AND r.status='running' ORDER BY d.created_at DESC LIMIT 1", [originId])).rows[0];
    return !!task;
  }, { timeout: 30000 }).toBe(true);
  const childId = task!.child_conversation_id;
  let terminalPending = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/chat/${childId}/stream`, route => route.fulfill({ status: 204 }));
  await page.route(`**/api/chat/${childId}`, async route => {
    const response = await route.fetch(); const data = await response.json();
    if (data.task?.status === "succeeded") { terminalPending = true; await held; }
    await route.fulfill({ response, json: data }).catch(() => {});
  });
  await page.goto(`/c/${childId}`);
  await expect.poll(() => terminalPending, { timeout: 45000 }).toBe(true);
  await page.getByRole("link", { name: "Originating chat", exact: true }).click();
  await page.waitForURL(`/c/${originId}`);
  release();
  const row = page.locator(`nav a[href="/c/${childId}"]`);
  await expect(row.getByRole("img", { name: "Completed task · Unread", exact: true })).toBeVisible();
  expect((await pool.query("SELECT read_at FROM inbox_items WHERE id=$1", [`task_${task!.id}`])).rows[0]?.read_at ?? null).toBeNull();
});

test("mobile reduced-motion task status remains visible and task metadata stays owner scoped", async ({ page, browser }) => {
  await login(page); await page.goto(`/c/${originId}`);
  await send(page, "delegate [async] [slow] explain a long detailed sequence for planning independent tasks and carefully preserving each result across pages with all the necessary verification and review steps");
  let task: { child_conversation_id: string; child_run_id: string };
  await expect.poll(async () => {
    task = (await pool.query("SELECT d.child_conversation_id,d.child_run_id FROM delegated_tasks d JOIN agent_runs r ON r.id=d.child_run_id WHERE d.origin_conversation_id=$1 AND r.status='running' ORDER BY d.created_at DESC LIMIT 1", [originId])).rows[0];
    return !!task;
  }, { timeout: 30000 }).toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
  const row = page.locator(`nav:visible a[href="/c/${task!.child_conversation_id}"]`);
  await expect(row.getByRole("img", { name: "Task working", exact: true })).toBeVisible();
  expect(await row.locator("svg").evaluate(el => getComputedStyle(el).animationName)).toBe("none");
  expect(await row.evaluate(el => getComputedStyle(el).maskImage)).toBe("none");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `${screenshots}/recent-mobile-reduced-motion.png`, fullPage: true });
  const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin, ignoreHTTPSErrors: process.env.TEST_HTTPS === "1" });
  const other = await otherContext.newPage(); await login(other, "task-other");
  expect(await (await other.request.get("/api/chat/recent-tasks")).json()).toEqual([]);
  expect((await other.request.get(`/api/chat/${task!.child_conversation_id}`)).status()).toBe(404);
  expect((await other.request.post(`/api/chat/${task!.child_conversation_id}/read`, { headers: { origin: new URL(page.url()).origin }, data: { runId: task!.child_run_id, status: "succeeded", lastSeq: 0 } })).status()).toBe(404);
  await otherContext.close();
  await page.request.post(`/api/chat/${originId}/stop`);
});
