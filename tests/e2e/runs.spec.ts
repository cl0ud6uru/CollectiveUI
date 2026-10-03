import { expect, test, type Page } from "@playwright/test";
import { login, openBot, send } from "./helpers";

// Durable runs (P6): replies run in the worker, so they survive reloads and closed tabs, and Stop is a request to
// the server. Needs the worker running (see README → "Running the tests"). `[slow]` makes mock-llm stream one word
// every 400 ms; its reply echoes the message ("You said: "…""), so the last word marks a complete reply.

/** A `[slow]` message of `n` words ending in `last`: the reply takes about n × 0.4 s. */
const slow = (n: number, last: string) => `[slow] ${Array.from({ length: n - 1 }, (_, i) => `word${i + 1}`).join(" ")} ${last}`;

const reply = (page: Page) => page.getByText(/You said:/);
const stopButton = (page: Page) => page.getByLabel("Stop generating");

async function sendAndWaitForFirstWords(page: Page, text: string) {
  await send(page, text);
  await page.waitForURL(/\/c\//);
  await expect(reply(page).first()).toBeVisible({ timeout: 30_000 });
}

test("reloading mid-reply resumes the live reply to the end, exactly once", async ({ page }) => {
  await login(page, "bob");
  await sendAndWaitForFirstWords(page, slow(15, "resumeomega"));
  await expect(page.getByText(/You said: .*resumeomega/)).toHaveCount(0);

  await page.reload();
  await expect(page.getByText(/You said: .*resumeomega/)).toBeVisible({ timeout: 30_000 });
  await expect(stopButton(page)).toHaveCount(0, { timeout: 15_000 });
  await expect(reply(page)).toHaveCount(1);

  // It was saved whole, once.
  await page.reload();
  await expect(page.getByText(/You said: .*resumeomega/)).toBeVisible();
  await expect(reply(page)).toHaveCount(1);
  await expect(stopButton(page)).toHaveCount(0);
});

test("closing the tab after the first words doesn't cut the reply short", async ({ page, context }) => {
  await login(page, "bob");
  await sendAndWaitForFirstWords(page, slow(15, "closedomega"));
  const url = page.url();
  await page.close();

  const again = await context.newPage();
  await again.goto(url);
  // Either still streaming (resumed) or already saved: in both cases the whole reply.
  await expect(again.getByText(/You said: .*closedomega/)).toBeVisible({ timeout: 30_000 });
  await expect(stopButton(again)).toHaveCount(0, { timeout: 15_000 });
  await again.reload();
  await expect(again.getByText(/You said: .*closedomega/)).toBeVisible();
  await expect(reply(again)).toHaveCount(1);
});

test("Stop stops the reply on the server: it stays partial after reloads", async ({ page }) => {
  await login(page, "bob");
  await sendAndWaitForFirstWords(page, slow(40, "stoppedomega"));
  await stopButton(page).click();
  await expect(stopButton(page)).toHaveCount(0);
  // Let the worker save the partial reply and finish the run.
  await page.waitForTimeout(1500);

  for (let i = 0; i < 2; i++) {
    await page.reload();
    await expect(reply(page).first()).toBeVisible();
    // Nothing is running any more, so nothing resumes.
    await expect(stopButton(page)).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByText(/You said: .*stoppedomega/)).toHaveCount(0);
    await expect(reply(page)).toHaveCount(1);
  }
});

test("Stop and send: the new message's reply follows, without an error", async ({ page }) => {
  await login(page, "bob");
  await sendAndWaitForFirstWords(page, slow(30, "firstomega"));

  await page.getByLabel("Message", { exact: true }).fill("second question after stop");
  await page.getByLabel("Stop and send").click();
  await expect(page.getByText('You said: "second question after stop"')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);
  await expect(page.getByText(/still in progress|Something went wrong/)).toHaveCount(0);
  await expect(page.getByText(/You said: .*firstomega/)).toHaveCount(0);

  // Saved in order: the stopped partial, then the new question and its reply.
  await expect(stopButton(page)).toHaveCount(0, { timeout: 15_000 });
  await page.reload();
  await expect(page.getByText('You said: "second question after stop"')).toBeVisible();
  await expect(reply(page)).toHaveCount(2);
});

test("an approval card pending across a reload can still be answered", async ({ page }) => {
  await login(page, "alice");
  await openBot(page, "Research Assistant");
  // Bot selection now resumes the home. Isolate this approval from previous bot/routine test history.
  const home = page.url();
  await page.getByRole("button", { name: "Start side chat", exact: true }).click();
  await expect(page).not.toHaveURL(home);
  await expect(page.getByText("Researches topics").first()).toBeVisible();
  await send(page, '[tool:fetch_url {"url":"https://example.com/runs-e2e"}]');
  await page.waitForURL(/\/c\//);
  await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible({ timeout: 30_000 });

  await page.reload();
  await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible();
  await page.getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByText(/Read page( — failed)?$/).last()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^The `?fetch_url`? tool returned/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Allow once" })).toHaveCount(0);

  await page.reload();
  await expect(page.getByText(/^The `?fetch_url`? tool returned/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow once" })).toHaveCount(0);
});
