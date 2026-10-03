import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { mkdir } from "node:fs/promises";
import { hashPassword } from "../../src/lib/auth/password";
import { sealAppSecret } from "../../src/lib/llm/secrets";
import { send as sendMessage } from "./helpers";

test.skip(process.env.FOLLOWUP_BROWSER !== "1", "Requires isolated local mock installation");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const password = "Synthetic-followup-browser!42";
const owner = "followup-browser-owner", other = "followup-browser-other", receiver = "followupReceiver", assigner = "followupAssigner", app = "followup-browser-model";
const screenshots = process.env.FOLLOWUP_SCREENSHOTS ?? "/tmp/collective-followups-screenshots";
const continueTool = `continue_receiver_${receiver.slice(-10)}`;
const marker = (taskId: string, task: string) => `[tool:${continueTool} ${JSON.stringify({ taskId, task })}]`;
let originId: string, taskId: string, childId: string, originalRunId: string;
async function login(page: Page, username = "followup-owner") {
  await page.goto("/login");
  await page.getByLabel("Local username or email").fill(username);
  await page.getByLabel("Local password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in with local account" }).click();
  await page.waitForURL(url => url.pathname === "/" || url.pathname.startsWith("/c/"));
}
const tasks = async () => (await pool.query("SELECT d.*,r.status,r.last_seq,r.started_at,r.message_id FROM delegated_tasks d JOIN agent_runs r ON r.id=d.child_run_id WHERE d.child_conversation_id=$1 ORDER BY d.turn", [childId])).rows;
const completedParent = async () => expect.poll(async () => (await pool.query("SELECT status FROM agent_runs WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 1", [originId])).rows[0]?.status, { timeout: 45000 }).toBe("succeeded");
async function send(page: Page, text: string) {
  await page.waitForURL(/\/c\//);
  const conversationId = page.url().split("/c/")[1];
  const count = async () => Number((await pool.query("SELECT count(*) FROM agent_runs WHERE conversation_id=$1", [conversationId])).rows[0].count);
  const before = await count();
  await sendMessage(page, text);
  // Wait for this request's admission before checking status; the previous run is already completed.
  await expect.poll(count, { timeout: 15000 }).toBe(before + 1);
}

test.beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/collective_followups_browser_test") throw new Error("Named disposable follow-up browser DB required");
  await pool.query("DELETE FROM auth_throttle");
  await pool.query("DELETE FROM users WHERE id=ANY($1)", [[owner, other]]);
  await pool.query("DELETE FROM ai_apps WHERE id=$1", [app]);
  const hash = await hashPassword(password);
  for (const [id, username] of [[owner, "followup-owner"], [other, "followup-other"]]) {
    await pool.query("INSERT INTO users(id,upn,name,identity_realm,auth_source) VALUES ($1,$2,'Follow-up fixture','local','local')", [id, `local:${username}`]);
    await pool.query("INSERT INTO local_credentials(user_id,username,password_hash,must_change_password) VALUES ($1,$2,$3,false)", [id, username, hash]);
    await pool.query("INSERT INTO local_login_aliases(login,user_id) VALUES ($1,$2)", [username, id]);
  }
  await pool.query("INSERT INTO ai_apps(id,name,provider,model,base_url,api_key_enc,supports_tools) VALUES ($1,'Local follow-up model','openai-compatible','mock-gpt','http://127.0.0.1:4069/v1',$2,true)", [app, sealAppSecret(app, "local-mock-only")]);
  await pool.query("INSERT INTO bots(id,owner_id,name,app_id,visibility,coordinator_eligible) VALUES ($1,$3,'Queen',$4,'org',false),($2,$3,'Receiver',$4,'org',true)", [assigner, receiver, owner, app]);
  await pool.query("INSERT INTO settings(key,value) VALUES ('coordinator',$1) ON CONFLICT(key) DO UPDATE SET value=$1", [JSON.stringify({ enabled: true, defaultBotId: assigner, starterBotId: null })]);
  await mkdir(screenshots, { recursive: true });
});
test.afterAll(async () => { await pool.end(); });
test.describe.configure({ mode: "serial" });

test("new delegation is immediately in Recent; completed follow-up reuses it and preserves model history", async ({ page, context }) => {
  await login(page); await page.goto(`/?bot=${assigner}`); await page.waitForURL(/\/c\//); originId = page.url().split("/c/")[1];
  await send(page, "delegate [async] Original sensor reading is 23 degrees");
  await completedParent();
  const original = (await pool.query("SELECT * FROM delegated_tasks WHERE origin_conversation_id=$1", [originId])).rows[0];
  taskId = original.id; childId = original.child_conversation_id; originalRunId = original.child_run_id;
  const before = (await tasks())[0];
  await expect(page.locator(`nav a[href="/c/${childId}"]`)).toHaveCount(1);
  const taskPage = await context.newPage(); await taskPage.goto(`/c/${childId}`);
  await expect(taskPage.getByText("Completed", { exact: true })).toBeVisible();
  await page.bringToFront();
  await send(page, marker(taskId, "[slow] [history] What was the original sensor reading?"));
  await expect.poll(async () => (await tasks()).length, { timeout: 15000 }).toBe(2);
  const second = (await tasks())[1]; expect(second.child_conversation_id).toBe(childId);
  const stale = await page.request.post(`/api/chat/${childId}/read`, { data: { runId: before.child_run_id, status: before.status, lastSeq: before.last_seq }, headers: { origin: "http://localhost:3069" } });
  expect(stale.status()).toBe(409);
  const recent = page.locator(`nav a[href="/c/${childId}"]`);
  await expect(recent).toHaveCount(1); await expect(recent.getByRole("img", { name: /Task (working|queued)/ })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/followup-working-one-recent.png`, fullPage: true });
  // The already-mounted completed task view must discover and attach to the new run.
  await taskPage.bringToFront();
  await expect(taskPage.getByText("Working", { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(taskPage.getByText("Completed", { exact: true })).toBeVisible({ timeout: 45000 });
  await expect(taskPage.getByRole("main").getByText(/History:.*Original sensor reading is 23 degrees/)).toBeVisible();
  await expect.poll(async () => (await pool.query("SELECT read_at FROM inbox_items WHERE id=$1", [`task_${second.id}`])).rows[0]?.read_at).toBeTruthy();
  await completedParent();
  await expect(taskPage.locator(`nav a[href="/c/${childId}"]`).getByRole("img", { name: "Completed task · Unread", exact: true })).toHaveCount(0);
  await taskPage.screenshot({ path: `${screenshots}/followup-context-completed.png`, fullPage: true });
  await completedParent(); await taskPage.close();
});

test("related turns queue while busy, stay in one Recent entry, and execute once in order", async ({ page, context }) => {
  await login(page); await page.goto(`/c/${originId}`);
  const before = (await tasks()).length;
  await send(page, `[parallel] ${marker(taskId, "[hold] [history] Busy follow-up A: explain the original sensor and its recent reading carefully")} ${marker(taskId, "[hold] [history] Follow-up B on the same sensor")}`);
  await expect.poll(async () => (await tasks()).length, { timeout: 15000 }).toBe(before + 2);
  await expect.poll(async () => (await tasks()).slice(-2).map(t => t.status).join(","), { timeout: 15000 }).toBe("running,queued");
  const [a, b] = (await tasks()).slice(-2);
  const taskPage = await context.newPage(); await taskPage.goto(`/c/${childId}`);
  await expect(taskPage.getByText("1 follow-up queued", { exact: true })).toBeVisible();
  await expect(taskPage.locator(`nav a[href="/c/${childId}"]`)).toHaveCount(1);
  await taskPage.screenshot({ path: `${screenshots}/followup-busy-queue.png`, fullPage: true });
  await completedParent();
  await expect(taskPage.getByText("Completed", { exact: true })).toBeVisible({ timeout: 15000 });
  const results = (await tasks()).slice(-2); expect(results.map(t => t.status)).toEqual(["succeeded", "succeeded"]);
  expect(results.every(t => t.returned_at)).toBe(true);
  const [order] = (await pool.query("SELECT a.finished_at <= b.started_at AS ordered FROM agent_runs a,agent_runs b WHERE a.id=$1 AND b.id=$2", [a.child_run_id, b.child_run_id])).rows;
  expect(order.ordered).toBe(true);
  await expect(taskPage.getByRole("main").getByText(/History:.*Busy follow-up A/).last()).toBeVisible();
  await taskPage.close();
});

test("unrelated work still starts another task and forged IDs cannot reuse private history", async ({ page, browser }) => {
  await login(page); await page.goto(`/c/${originId}`);
  await send(page, "delegate [async] Unrelated calendar planning"); await completedParent();
  const chats = (await pool.query("SELECT DISTINCT child_conversation_id FROM delegated_tasks WHERE origin_conversation_id=$1", [originId])).rows;
  expect(chats).toHaveLength(2);
  await expect(page.locator(`nav a[href="/c/${childId}"]`)).toHaveCount(1);
  await page.screenshot({ path: `${screenshots}/unrelated-separate-task.png`, fullPage: true });
  const ownWrongRun = await page.request.get(`/api/chat/${childId}/stream?runId=unknown-run`);
  expect(ownWrongRun.status()).toBe(204);
  const parentRun = (await pool.query("SELECT id FROM agent_runs WHERE conversation_id=$1 LIMIT 1", [originId])).rows[0].id;
  expect((await page.request.get(`/api/chat/${childId}/stream?runId=${parentRun}`)).status()).toBe(404);
  await send(page, marker("unknown-task", "No fabricated ID")); await completedParent();
  await expect(page.getByRole("main").getByText(/Related task not found/).last()).toBeVisible();
  const otherContext = await browser.newContext(); const outsider = await otherContext.newPage();
  await login(outsider, "followup-other");
  expect((await outsider.request.get(`/api/chat/${childId}`)).status()).toBe(404);
  expect((await outsider.request.get(`/api/chat/${childId}/stream?runId=${originalRunId}`)).status()).toBe(404);
  await send(outsider, marker(taskId, "Try cross-user continuation"));
  await expect(outsider.getByRole("main").getByText(/Related task not found/).last()).toBeVisible({ timeout: 30000 });
  expect((await pool.query("SELECT id FROM delegated_tasks WHERE user_id=$1", [other])).rows).toHaveLength(0);
  await otherContext.close();
});

test("Stop cancels active and queued follow-ups, old read markers stay stale, and failure can be explicitly continued", async ({ page }) => {
  await login(page); await page.goto(`/c/${originId}`);
  const before = (await tasks()).at(-1)!;
  await send(page, `[parallel] ${marker(taskId, "[hold] Stop this follow-up while it is working and preserve its status")} ${marker(taskId, "[hold] Queued follow-up must not run after Stop")}`);
  await expect.poll(async () => (await tasks()).slice(-2).map(t => t.status).join(","), { timeout: 15000 }).toBe("running,queued");
  await page.goto(`/c/${childId}`); await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(async () => (await tasks()).slice(-2).map(t => t.status).join(","), { timeout: 30000 }).toBe("cancelled,cancelled");
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible({ timeout: 15000 });
  expect((await tasks()).at(-1)!.started_at).toBeNull();
  expect((await page.request.post(`/api/chat/${childId}/read`, { data: { runId: before.child_run_id, status: before.status, lastSeq: before.last_seq }, headers: { origin: "http://localhost:3069" } })).status()).toBe(409);
  await page.screenshot({ path: `${screenshots}/followup-stopped.png`, fullPage: true });
  await completedParent(); await page.goto(`/c/${originId}`);
  await send(page, marker(taskId, "[task-error] Explicit failed follow-up")); await completedParent();
  expect((await tasks()).at(-1)!.status).toBe("failed");
  await expect(page.locator(`nav a[href="/c/${childId}"]`).getByRole("img", { name: "Task failed · Unread", exact: true })).toBeVisible();
  await page.goto(`/c/${childId}`); await expect(page.getByText("Failed", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/followup-failed.png`, fullPage: true });
  await page.goto(`/c/${originId}`); await send(page, marker(taskId, "[history] Explicit recovery, do not rerun old actions")); await completedParent();
  expect((await tasks()).at(-1)!.status).toBe("succeeded");
});
