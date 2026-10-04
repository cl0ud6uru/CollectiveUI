/** Runs with the actual worker image and its production dependencies; no Vitest/mocks/import interception. */
import assert from "node:assert/strict";
import { access, constants } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { db, pool } from "@/db";
import { aiApps, bots, conversations, messages, usageEvents, users } from "@/db/schema";
import { loadPrincipal } from "@/lib/auth/groups";
import { newId } from "@/lib/ids";
import { getBoss } from "@/lib/jobs";
import { sealAppSecret } from "@/lib/llm/secrets";
import { getRun } from "@/lib/runs/state";
import { startRun } from "@/lib/runs/store";

const runtimeRequire = createRequire(`${process.cwd()}/package.json`);

async function main() {
  assert.equal(process.env.NODE_ENV, "production");
  assert.notEqual(process.getuid?.(), 0, "the worker must run as non-root");
  assert.equal(new URL(process.env.DATABASE_URL!).pathname, "/collective_worker_test");
  for (const file of ["/app", "/app/src", "/app/node_modules", "/app/src/worker/index.ts"]) {
    await assert.rejects(access(file, constants.W_OK), `${file} must not be writable`);
  }
  await access(process.env.STORAGE_DIR!, constants.W_OK);
  const lock = runtimeRequire("./package-lock.json") as { packages: Record<string, { dev?: boolean }> };
  const shippedDev = Object.entries(lock.packages).filter(([file, pkg]) => pkg.dev && existsSync(file));
  assert.deepEqual(shippedDev, [], "no lockfile dev-only package may be shipped");
  for (const name of ["vitest", "eslint", "drizzle-kit", "typescript", "@playwright/test"]) {
    assert.throws(() => runtimeRequire.resolve(`${name}/package.json`), { code: "MODULE_NOT_FOUND" });
  }
  for (const directory of ["/app/tests", "/app/dev", "/app/.github"]) assert(!existsSync(directory));
  for (const name of ["tsx", "pg", "drizzle-orm"]) assert(runtimeRequire.resolve(name));

  // All data lives in the Compose fixture DB, destroyed by worker-smoke.sh even on failure.
  const userId = newId();
  await db.insert(users).values({ id: userId, upn: `${userId}@fixture.invalid`, name: "Worker fixture", authSource: "ldap" });
  const appId = newId();
  const [app] = await db.insert(aiApps).values({
    id: appId, name: "Worker mock", provider: "openai-compatible", baseUrl: "http://mock:4010/v1",
    apiKeyEnc: sealAppSecret(appId, "synthetic-fixture-key"), model: "mock-gpt", supportsTools: true,
  }).returning();
  const [bot] = await db.insert(bots).values({ ownerId: userId, name: "Worker fixture", appId }).returning();
  const [conversation] = await db.insert(conversations).values({ userId, botId: bot.id, title: "Worker smoke" }).returning();
  const principal = await loadPrincipal(userId);
  assert(principal);
  assert.equal(principal.isAdmin, false);
  const text = "hello from the production worker image";
  const run = await startRun({
    principal, conversation, bot, app, parentId: null,
    userMessage: { id: newId(), role: "user", parts: [{ type: "text", text }], metadata: { createdAt: Date.now() } },
  });
  const deadline = Date.now() + 60_000;
  let result = await getRun(run.id);
  while (result && ["queued", "running"].includes(result.status) && Date.now() < deadline) {
    await delay(250);
    result = await getRun(run.id);
  }
  assert.equal(result?.status, "succeeded", JSON.stringify(result));
  assert.equal(result.userId, userId);
  assert.equal(result.error, null);
  const [message] = await db.select().from(messages).where(eq(messages.id, run.messageId));
  assert.equal(message.role, "assistant");
  assert.equal(message.conversationId, conversation.id);
  const parts = message.parts as { type: string; text?: string }[];
  assert(parts.some(part => part.type === "text" && part.text?.includes(`You said: "${text}"`)));
  const usage = await db.select().from(usageEvents).where(eq(usageEvents.runId, run.id));
  assert(usage.length > 0);
  assert(usage.every(event => event.userId === userId && event.messageId === run.messageId));
  console.log("Worker image: non-root, immutable application, no dev-only packages, queued reply and usage persistence passed.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await getBoss().then(boss => boss.stop()).catch(() => {});
  await pool.end();
});
