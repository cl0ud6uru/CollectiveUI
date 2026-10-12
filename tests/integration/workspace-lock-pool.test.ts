import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

// This probe writes one audit row and is enabled only for explicitly named disposable test databases.
const databaseUrl = process.env.DATABASE_URL;
const databaseName = databaseUrl ? new URL(databaseUrl).pathname.slice(1) : "";
const run = /(?:^|[_-])test(?:ing)?(?:[_-]|$)/i.test(databaseName) ? describe : describe.skip;
const previousPoolMax = process.env.DATABASE_POOL_MAX;

let pool: (typeof import("@/db"))["pool"] | undefined;
afterAll(async () => {
  await pool?.end();
  if (previousPoolMax === undefined) delete process.env.DATABASE_POOL_MAX;
  else process.env.DATABASE_POOL_MAX = previousPoolMax;
});

run("single-slot workspace owner lock", () => {
  it("routes locked settings and audit queries through the held connection", async () => {
    process.env.DATABASE_POOL_MAX = "1";
    const database = await import("@/db");
    pool = database.pool;
    expect(pool.options.max).toBe(1);
    const [{ withWorkspaceUserLock }, { getSetting }, { audit }, { auditLog }] = await Promise.all([
      import("@/lib/workspaces/locks"),
      import("@/lib/settings"),
      import("@/lib/audit"),
      import("@/db/schema"),
    ]);
    const action = `workspace.pool_slot_probe.${randomUUID()}`;

    await withWorkspaceUserLock(`pool-slot-probe:${randomUUID()}`, async (lockedDb) => {
      await getSetting("sandbox", lockedDb);
      await audit(null, action, undefined, undefined, lockedDb);
      await lockedDb.delete(auditLog).where((await import("drizzle-orm")).eq(auditLog.action, action));
    });

    expect(pool.waitingCount).toBe(0);
  }, 10_000);
});
