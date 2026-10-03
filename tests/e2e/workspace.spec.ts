import { expect, test, type Page } from "@playwright/test";
import { login, openBot, send, choose } from "./helpers";

// Needs sandboxd (npm run sandboxd:dev) and SANDBOXD_URL/SANDBOXD_SECRET in the app's environment; skipped otherwise.
// Mock payloads avoid "}]" inside strings (the mock's scripted tool-call syntax ends there).

async function workspaceSettings(page: Page, patch: { enabled: boolean; everyone?: boolean }) {
  await page.goto("/admin/sandboxes");
  const toggle = page.getByLabel("Enable workspaces");
  if ((await toggle.getAttribute("aria-checked")) !== String(patch.enabled)) await toggle.click();
  if (patch.everyone !== undefined) await choose(page, page.getByLabel("Who gets a workspace"), patch.everyone ? "everyone" : "selected");
  await page.getByRole("button", { name: "Save workspace settings" }).click();
  await expect(page.getByText("Saved").first()).toBeVisible();
}

test("workspaces: approvals per kind of change, per-person isolation, stop, reset and destroy", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const botName = `E2E Workspace bot ${stamp}`;
  const file = `notes/e2e-${stamp}.txt`;

  await login(page, "alice");
  await page.goto("/admin/sandboxes");
  test.skip(await page.getByText("Workspaces aren't set up").isVisible(), "sandboxd isn't configured for this app (SANDBOXD_URL)");
  await expect(page.getByText("healthy")).toBeVisible();
  await workspaceSettings(page, { enabled: true, everyone: true });

  try {
    // A bot with the Workspace tools (only offered while workspaces are on), usable by everyone.
    await page.goto("/bots/new");
    await page.getByRole("button", { name: "configure" }).click();
    await page.getByPlaceholder("Name your bot").fill(botName);
    await choose(page, page.getByLabel("Who can use it"), "org");
    await page.getByLabel("Workspace", { exact: true }).check();
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.waitForURL(/\/bots\/.+\/edit/);

    // Writing a file asks first; "Always allow" is on offer for writes.
    await openBot(page, botName);
    await send(page, `[tool:workspace_write {"path":"${file}","content":"hello from e2e"}]`);
    await expect(page.getByText(`wants to write`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Always allow" })).toBeVisible();
    await page.getByRole("button", { name: "Allow once" }).click();
    await expect(page.getByText(/"created": ?true/).first()).toBeVisible({ timeout: 60_000 });

    // Reading runs without asking.
    await send(page, `[tool:workspace_read {"path":"${file}"}]`);
    await expect(page.getByText(/1 {2}hello from e2e/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Allow once" })).toHaveCount(0);

    // Commands show exactly what will run, and can't be always-allowed. They run as the unprivileged agent user.
    await send(page, `[tool:workspace_bash {"command":"id -u && cat ${file}"}]`);
    await expect(page.getByText("wants to run a command in your workspace")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(`id -u && cat ${file}`).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Always allow" })).toHaveCount(0);
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByText(/exit 0/).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("pre", { hasText: /^1000\nhello from e2e/ }).first()).toBeVisible();

    // A denied command doesn't run: the file is still there.
    await send(page, `[tool:workspace_bash {"command":"rm ${file}"}]`);
    await expect(page.getByText("wants to run a command in your workspace")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Deny" }).click();
    await expect(page.getByRole("button", { name: "Deny" })).toHaveCount(0, { timeout: 30_000 });
    await send(page, `[tool:workspace_list {"path":"notes"}]`);
    await expect(page.getByText(new RegExp(`notes/e2e-${stamp}\\.txt \\(14 B\\)`)).first()).toBeVisible({ timeout: 30_000 });

    // Settings → Workspace: stop it; the next tool call starts it again with the files intact.
    await page.goto("/settings?tab=workspace");
    await expect(page.getByText("Running", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("gVisor isolation").or(page.getByText("standard isolation"))).toBeVisible();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByText("Stopped", { exact: true })).toBeVisible({ timeout: 30_000 });
    await openBot(page, botName);
    await send(page, `[tool:workspace_read {"path":"${file}"}]`);
    await expect(page.getByText(/1 {2}hello from e2e/).first()).toBeVisible({ timeout: 60_000 });

    // Bob, on the same bot, gets his own workspace: alice's file isn't there.
    const bobContext = await browser.newContext();
    const bob = await bobContext.newPage();
    await login(bob, "bob");
    await openBot(bob, botName);
    await send(bob, `[tool:workspace_read {"path":"${file}"}]`);
    await expect(bob.getByText(/doesn't exist/).first()).toBeVisible({ timeout: 60_000 });
    await bobContext.close();

    // Reset deletes alice's files (typed confirmation).
    await page.goto("/settings?tab=workspace");
    await page.getByRole("button", { name: "Reset…" }).click();
    await expect(page.getByRole("button", { name: "Delete all files" })).toBeDisabled();
    await page.getByLabel("Type reset to confirm").fill("reset");
    await page.getByRole("button", { name: "Delete all files" }).click();
    await expect(page.getByText("Workspace reset")).toBeVisible();
    await expect(page.getByText("Not created yet")).toBeVisible();

    // The admin sees bob's workspace and can destroy it.
    await page.goto("/admin/sandboxes");
    page.once("dialog", (d) => d.accept());
    await page.getByLabel("Destroy Bob Builder's workspace").click();
    await expect(page.getByText("Workspace deleted")).toBeVisible();
  } finally {
    await workspaceSettings(page, { enabled: false, everyone: false });
  }
});
