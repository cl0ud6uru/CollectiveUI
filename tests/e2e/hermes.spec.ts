import { existsSync, mkdirSync, rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { login, openBot, send, choose } from "./helpers";

// Needs a Hermes gateway whose profile runs on dev/mock-llm (so scripted tool calls work), reachable from the app:
//   HERMES_E2E_URL=http://127.0.0.1:8642 HERMES_E2E_PROFILE=coder HERMES_E2E_KEY=… npm run test:e2e -- hermes
// Skipped otherwise. The approval cases delete throwaway directories under /tmp on the Hermes host (the same machine
// in the dev setup).
const url = process.env.HERMES_E2E_URL;

test.skip(!url, "HERMES_E2E_URL isn't set");

test("a Hermes profile shows up as a bot: chat, tool steps, approvals, deny and stop", async ({ page }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const name = `E2E Hermes ${stamp}`;
  const profile = process.env.HERMES_E2E_PROFILE ?? "";

  await login(page, "alice");
  await page.goto("/admin/apps");
  await page.getByRole("button", { name: "Add app" }).click();
  const dialog = page.getByRole("dialog");
  await choose(page, dialog.getByLabel("Provider", { exact: true }), "hermes");
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog.getByLabel("Base URL").fill(url!);
  await dialog.getByLabel("Profile", { exact: true }).fill(profile);
  await dialog.getByLabel("Profile API key (API_SERVER_KEY)").fill(process.env.HERMES_E2E_KEY ?? "");
  // Settings Hermes ignores aren't offered.
  await expect(dialog.getByLabel("Temperature")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Test" }).click();
  await expect(page.getByText(/Connected — 1 model/)).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByLabel("Model id")).toHaveValue(profile || /.+/);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("App saved — its bot is under Bots")).toBeVisible();

  try {
    // The bot the app created; its builder explains that tools live in Hermes.
    await page.goto("/bots");
    await expect(page.getByRole("link", { name: `Chat with ${name}`, exact: true })).toBeVisible();

    await openBot(page, name);
    await send(page, "hello from the portal");
    await expect(page.getByText('You said: "hello from the portal"').first()).toBeVisible({ timeout: 30_000 });

    // A Hermes tool step renders as a tool row.
    await send(page, '[tool:terminal {"command":"echo hermes-e2e-ok"}]');
    await expect(page.getByText("Hermes used terminal").first()).toBeVisible({ timeout: 30_000 });

    // A flagged command: the approval card shows the command and Hermes' reason, with no "Always allow".
    const dir = `/tmp/portal-hermes-e2e-${stamp}`;
    mkdirSync(dir, { recursive: true });
    await send(page, `[tool:terminal {"command":"rm -rf ${dir}"}]`);
    await expect(page.getByText(/Hermes flagged this:/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(`rm -rf ${dir}`).first()).toBeVisible();
    await expect(page.getByText(/Hermes denies it if nobody answers within 5 min/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Always allow" })).toHaveCount(0);
    // The turn waits in the worker (holding Hermes' event stream), so a reload still shows the card and can answer it.
    await page.reload();
    await expect(page.getByText(/Hermes flagged this:/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Allow once" }).click();
    await expect(page.getByText(/approved by the user/).first()).toBeVisible({ timeout: 30_000 });
    expect(existsSync(dir)).toBe(false);

    // Denied: the command doesn't run.
    const keep = `/tmp/portal-hermes-e2e-${stamp}-keep`;
    mkdirSync(keep, { recursive: true });
    await send(page, `[tool:terminal {"command":"rm -rf ${keep}"}]`);
    await expect(page.getByText(/Hermes flagged this:/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Deny" }).click();
    await expect(page.getByText(/Hermes used terminal — denied/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Deny" })).toHaveCount(0);
    expect(existsSync(keep)).toBe(true);
    rmSync(keep, { recursive: true, force: true });

    // Stop ends the turn and the Hermes run: the stop endpoint cancels the run, whose abort posts /stop to Hermes.
    await send(page, "[slow] tell me a long story");
    await page.getByLabel("Stop generating").click();
    await expect(page.getByLabel("Stop generating")).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await page.goto("/admin/apps");
    page.once("dialog", (d) => d.accept());
    await page.getByLabel(`Delete ${name}`).click();
    // Wait for the delete to land: a leftover Hermes app becomes the default target of later specs.
    await expect(page.getByLabel(`Delete ${name}`)).toHaveCount(0, { timeout: 15_000 });
  }
});
