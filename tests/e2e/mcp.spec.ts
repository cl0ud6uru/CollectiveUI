import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { login, openBot, send } from "./helpers";

// Runs its own dev/mcp-echo, started once the portal has issued the identity secret (as a real app would be
// configured), requiring that identity for this server's URL.
let echo: ChildProcess | undefined;
test.afterAll(() => echo?.kill());

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function startEcho(port: number, env: Record<string, string>) {
  echo = spawn(process.execPath, [path.resolve("dev/mcp-echo/server.mjs")], { env: { ...process.env, PORT: String(port), ...env }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("mcp-echo did not start")), 10_000);
    echo!.stdout!.on("data", (d: Buffer) => d.toString().includes("listening") && (clearTimeout(timer), resolve()));
  });
}

test("admin imports an MCP server, turns on identity, tests and enables it; a bot uses it with smart approvals", async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const name = `E2E Echo ${stamp}`;
  const prefix = `e2e_echo_${stamp}`;
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/mcp`;

  // Import a Claude Code-style config: the remote server becomes a draft, the stdio one is explained.
  await login(page, "alice");
  await page.goto("/admin/mcp");
  await page.getByRole("button", { name: "Import" }).click();
  const importDialog = page.getByRole("dialog");
  await importDialog
    .getByLabel("Client config (JSON)")
    .fill(JSON.stringify({ mcpServers: { [name]: { type: "http", url }, "Local files": { command: "npx", args: ["server-filesystem"] } } }));
  await importDialog.getByRole("button", { name: "Check" }).click();
  await expect(importDialog.getByText("can't import")).toBeVisible();
  await importDialog.getByRole("button", { name: "Import 1 as drafts" }).click();
  await expect(page.getByText(/Imported 1 server/)).toBeVisible();
  const row = page.getByRole("row", { name: new RegExp(name) });
  await expect(row.getByText("draft")).toBeVisible();

  // Trust it and turn on the identity header: the secret is shown once.
  await row.getByText(name).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Send identity").click();
  await dialog.getByLabel("Trusted server").click();
  await dialog.getByRole("button", { name: "Save" }).click();
  const secret = (await dialog.getByLabel("Identity secret").textContent())!.trim();
  expect(secret).toMatch(/^[\w-]{43}$/);
  await dialog.getByRole("button", { name: "Done" }).click();
  await startEcho(port, { MCP_IDENTITY_SECRET: secret, MCP_REQUIRE_IDENTITY: "true", MCP_IDENTITY_AUDIENCE: url });

  // Test captures the tools; Enable is possible once there is a tool list.
  await row.getByLabel(`Test ${name}`).click();
  await expect(page.getByText(/^6 tools: /)).toBeVisible();
  // The toast comes before the refreshed list: wait for the row, or the dialog opens with the old server data.
  await expect(row.getByText("6 tools", { exact: true })).toBeVisible();
  await row.getByText(name).click();
  await expect(dialog.getByText("delete_record")).toBeVisible();
  await expect(dialog.getByText("destructive")).toBeVisible();
  await dialog.getByRole("button", { name: "Enable" }).click();
  await expect(row.getByText("enabled")).toBeVisible();
  expect(await page.content()).not.toContain(secret); // the secret isn't sent to the browser again

  // A bot with the server's tools, on the default "Ask unless read-only".
  const botName = `E2E MCP bot ${stamp}`;
  await page.goto("/bots/new");
  await page.getByRole("button", { name: "configure" }).click();
  await page.getByPlaceholder("Name your bot").fill(botName);
  await page.getByLabel(`${name} (MCP)`, { exact: true }).check();
  await expect(page.getByLabel(`${name} (MCP) approval`)).toHaveText("Ask unless read-only");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/bots\/.+\/edit/);

  // whoami is read-only on a trusted server: it runs without asking, and the server knows who is asking.
  await openBot(page, botName);
  await send(page, `[tool:${prefix}__whoami {}]`);
  await expect(page.getByText(/alice@corp\.local/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow once" })).toHaveCount(0);

  // delete_record is destructive: it asks first.
  await send(page, `[tool:${prefix}__delete_record {"id":"42"}]`);
  await page.getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByText(/deleted record 42/).first()).toBeVisible();

  // Clean up.
  await page.goto("/admin/mcp");
  page.once("dialog", (d) => d.accept());
  await page.getByLabel(`Delete ${name}`).click();
  await expect(page.getByRole("row", { name: new RegExp(name) })).toHaveCount(0);
});
