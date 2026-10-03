import { expect, test, type Page } from "@playwright/test";
import { startCommandServer } from "../fixtures/hermes/command-server.mjs";
import { login, openBot, send, choose } from "./helpers";

/** Uses the normal isolated dev stack plus this in-process HTTP fixture. Never contacts a real Hermes profile. */
let fixture: Awaited<ReturnType<typeof startCommandServer>>;
test.beforeAll(async () => { fixture = await startCommandServer(); });
test.afterAll(async () => { await fixture?.close(); });
const box = (page: Page) => page.getByLabel("Message", { exact: true });
const result = (page: Page) => page.getByRole("status", { name: "Command result" });
async function command(page: Page, text: string) {
  await box(page).fill(text);
  await box(page).press("Escape"); // submit the completed command without completing another menu item
  await expect(page.getByRole("button", { name: /^(Send message|Stop and send)$/ })).toBeEnabled();
  await box(page).press("Enter");
}
async function state() { return await (await fetch(`${fixture.url}/__test`)).json() as { calls: { method: string; path: string }[]; runs: { id: string; body: { input: string; model?: string; session_id: string }; status: string }[] }; }

test("Hermes controls: keyboard menu, preserved drafts, model scope, reset, approval cancellation and authorization", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const name = `E2E Hermes commands ${Date.now()}`;
  expect((await page.request.get("/api/chat/commands?conversationId=notowned1")).status()).toBe(401);
  await login(page, "alice");
  await page.goto("/admin/apps");
  await page.getByRole("button", { name: "Add app" }).click();
  const dialog = page.getByRole("dialog");
  await choose(page, dialog.getByLabel("Provider", { exact: true }), "hermes");
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog.getByLabel("Base URL").fill(fixture.url);
  await dialog.getByLabel("Profile", { exact: true }).fill("mock");
  await dialog.getByLabel("Profile API key (API_SERVER_KEY)").fill("isolated-hermes-key");
  await dialog.getByLabel("Model id").fill("coder");
  await dialog.getByLabel("Allowed model routes").fill("fast, reasoning");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("App saved — its bot is under Bots")).toBeVisible();

  try {
    await openBot(page, name);
    await box(page).fill("/");
    await expect(page.getByRole("listbox", { name: "Hermes commands" })).toBeVisible();
    await box(page).press("ArrowDown");
    await box(page).press("Tab");
    await expect(box(page)).toHaveValue("/status ");
    await box(page).press("Enter");
    await expect(result(page)).toContainText("no replies yet");
    await command(page, "/hermes help");
    await expect(result(page)).toContainText("Commands do not send a model message");
    await command(page, "/portal help");
    await expect(result(page)).toContainText("Portal skills aren't available");
    await expect(box(page)).toHaveValue("/portal help");
    await command(page, "/terminal ls");
    await expect(result(page)).toContainText("cannot change the shared profile");
    expect((await state()).runs).toHaveLength(0);

    await page.locator('input[type="file"]').setInputFiles({ name: "keep-draft.txt", mimeType: "text/plain", buffer: Buffer.from("isolated upload") });
    await expect(page.getByLabel("Remove keep-draft.txt")).toBeVisible();
    await command(page, "/help");
    await expect(result(page)).toContainText("Your draft and files have been kept");
    await expect(box(page)).toHaveValue("/help");
    await page.getByLabel("Remove keep-draft.txt").click();
    await command(page, "/skills");
    await expect(result(page)).toContainText("skills-discovery bug");
    await command(page, "/model");
    await expect(result(page)).toContainText("Allowed routes: fast, reasoning");
    await box(page).fill("/model f");
    await box(page).press("Tab");
    await expect(box(page)).toHaveValue("/model fast ");
    await box(page).press("Enter");
    await expect(result(page)).toContainText("Model request saved");
    await page.waitForURL(/\/c\//);
    const oldUrl = page.url();
    const conversationId = new URL(oldUrl).pathname.split("/").at(-1)!;
    await send(page, "hello with a model request");
    await expect(page.getByRole("main").getByText("Mock Hermes reply", { exact: true })).toBeVisible({ timeout: 30_000 });
    expect((await state()).runs.at(-1)?.body.model).toBe("fast");
    const firstSession = (await state()).runs.at(-1)!.body.session_id;
    await command(page, "/usage");
    await expect(result(page)).toContainText("12 input tokens; 4 output tokens");
    await command(page, "/status");
    await expect(result(page)).toContainText("Last reported model: actual-mock-model");

    // A stale/raw client also cannot accidentally put a command into the inference path.
    const raw = await page.request.post("/api/chat", { data: { conversationId, message: { id: "raw-command-123", role: "user", parts: [{ type: "text", text: "/reset" }] } } });
    expect(raw.status()).toBe(400);
    expect((await raw.json()).unsavedMessageId).toBe("raw-command-123");
    expect((await state()).runs).toHaveLength(1);
    await send(page, "//help");
    await expect.poll(async () => (await state()).runs.length).toBe(2);
    expect((await state()).runs.at(-1)?.body.input).toBe("/help");
    await expect(page.getByLabel("Stop generating")).toHaveCount(0);

    const otherContext = await browser.newContext();
    const bob = await otherContext.newPage();
    await login(bob, "bob");
    const foreign = await bob.request.post("/api/chat/commands", { data: { conversationId, text: "/stop" } });
    expect(foreign.status()).toBe(404);
    await otherContext.close();

    await command(page, "/new");
    await expect(page).not.toHaveURL(oldUrl);
    await expect(page.getByRole("main").getByText("Mock Hermes reply", { exact: true })).toHaveCount(0);
    await send(page, "new session hello");
    await expect(page.getByRole("main").getByText("Mock Hermes reply", { exact: true })).toBeVisible({ timeout: 30_000 });
    expect((await state()).runs.at(-1)?.body.session_id).not.toBe(firstSession);
    expect((await state()).runs.at(-1)?.body.model).toBe("fast");
    await page.reload();
    await command(page, "/model");
    await expect(result(page)).toContainText("Requested: fast");

    await send(page, "[approval] isolated approval");
    await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible({ timeout: 30_000 });
    await command(page, "/reset");
    await expect(result(page)).toContainText("unfinished reply or approval");
    await expect(box(page)).toHaveValue("/reset");
    await page.reload(); // approval remains cancellable after losing the original browser stream
    await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible();
    await command(page, "/stop");
    await expect(result(page)).toContainText("Hermes reply ended");
    await expect(page.getByRole("button", { name: "Allow once" })).toHaveCount(0, { timeout: 15_000 });
    expect((await state()).calls.some((c) => c.path.endsWith("/approval"))).toBe(false);
    await command(page, "/new");
    await expect(page.getByRole("main").getByText("Mock Hermes reply", { exact: true })).toHaveCount(0);

    await send(page, "[slow] isolated streaming run");
    await expect(page.getByLabel("Stop generating")).toBeVisible();
    await command(page, "/help");
    await expect(result(page)).toContainText("Commands do not send a model message");
    expect((await state()).runs.at(-1)?.status).toBe("running");
    await command(page, "/stop");
    await expect(result(page)).toContainText(/ended|requested/);
    await expect.poll(async () => (await state()).runs.at(-1)?.status).toBe("cancelled");
    await expect(page.getByLabel("Stop generating")).toHaveCount(0, { timeout: 15_000 });
    await page.setViewportSize({ width: 390, height: 844 });
    await box(page).fill("/");
    await expect(page.getByRole("listbox", { name: "Hermes commands" })).toBeVisible();
    await page.screenshot({ path: "test-results/hermes-commands-mobile.png" });
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.screenshot({ path: "test-results/hermes-commands-desktop.png" });
  } finally {
    await page.goto("/admin/apps");
    page.once("dialog", (d) => d.accept());
    await page.getByLabel(`Delete ${name}`).click();
    await expect(page.getByLabel(`Delete ${name}`)).toHaveCount(0, { timeout: 15_000 });
  }
});
