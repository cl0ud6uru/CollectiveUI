import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxState } from "@/sandboxd/protocol/types";

// A stand-in for sandboxd: records calls; list() returns whatever the test sets.
const stub = {
  stop: vi.fn(async (ref: string) => ({ ok: !!ref })),
  destroy: vi.fn(async (ref: string) => ({ ok: !!ref })),
  list: vi.fn(async (): Promise<SandboxState[]> => []),
};
vi.mock("@/lib/sandbox/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sandbox/client")>()),
  sandboxd: () => stub,
}));

// Integration: needs DATABASE_URL pointing at a migrated database. Skipped otherwise.
const run = process.env.DATABASE_URL ? describe : describe.skip;

run("workspace records (integration)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const alice = `it-sbx-a-${suffix}`;
  const bob = `it-sbx-b-${suffix}`;
  let saved: unknown;

  beforeAll(async () => {
    const { db } = await import("@/db");
    const { users } = await import("@/db/schema");
    const { getSetting, setSetting } = await import("@/lib/settings");
    await db.insert(users).values([
      { id: alice, upn: `${alice}@corp.local`, name: "Sandbox A", authSource: "ldap" },
      { id: bob, upn: `${bob}@corp.local`, name: "Sandbox B", authSource: "ldap" },
    ]);
    saved = await getSetting("sandbox");
    await setSetting("sandbox", { ...(saved as object), deleteAfterDays: 7 } as never);
  });

  afterAll(async () => {
    const { db } = await import("@/db");
    const { auditLog, users } = await import("@/db/schema");
    const { setSetting } = await import("@/lib/settings");
    await db.delete(auditLog).where(inArray(auditLog.target, [alice, bob]));
    await db.delete(users).where(inArray(users.id, [alice, bob])); // cascades to sandboxes
    await setSetting("sandbox", saved as never);
  });

  beforeEach(() => {
    stub.stop.mockReset().mockResolvedValue({ ok: true });
    stub.destroy.mockReset().mockResolvedValue({ ok: true });
    stub.list.mockReset().mockResolvedValue([]);
  });

  it("concurrent first uses agree on one random ref", async () => {
    const { getOrCreateRef } = await import("@/lib/sandbox/store");
    const { db } = await import("@/db");
    const { sandboxes } = await import("@/db/schema");
    const { REF_RE } = await import("@/sandboxd/protocol/types");
    const refs = await Promise.all(Array.from({ length: 12 }, () => getOrCreateRef(alice)));
    expect(new Set(refs).size).toBe(1);
    expect(refs[0]).toMatch(REF_RE);
    expect(refs[0]).not.toContain(alice.slice(0, 6));
    expect(await db.select().from(sandboxes).where(eq(sandboxes.userId, alice))).toHaveLength(1);
    expect(await getOrCreateRef(alice)).toBe(refs[0]);
    expect(await getOrCreateRef(bob)).not.toBe(refs[0]);
  });

  it("disabling someone schedules deletion and stops the workspace; re-enabling cancels it", async () => {
    const { getOrCreateRef, findSandbox } = await import("@/lib/sandbox/store");
    const { onUserDisabled, onUserEnabled } = await import("@/lib/sandbox/lifecycle");
    const ref = await getOrCreateRef(alice);

    const before = Date.now();
    await onUserDisabled(alice, bob);
    const row = await findSandbox(alice);
    expect(row!.deleteAfter!.getTime()).toBeGreaterThanOrEqual(before + 7 * 86_400_000 - 1000);
    expect(row!.deleteAfter!.getTime()).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000 + 1000);
    expect(stub.stop).toHaveBeenCalledWith(ref);

    await onUserEnabled(alice);
    expect((await findSandbox(alice))!.deleteAfter).toBeNull();
  });

  it("a failed stop still records the deletion date, and is audited", async () => {
    const { db } = await import("@/db");
    const { auditLog } = await import("@/db/schema");
    const { getOrCreateRef, findSandbox } = await import("@/lib/sandbox/store");
    const { onUserDisabled, onUserEnabled } = await import("@/lib/sandbox/lifecycle");
    await getOrCreateRef(alice);
    stub.stop.mockRejectedValueOnce(new Error("sandboxd down"));
    await onUserDisabled(alice, bob);
    expect((await findSandbox(alice))!.deleteAfter).not.toBeNull();
    const entries = await db.select().from(auditLog).where(and(eq(auditLog.target, alice), eq(auditLog.action, "workspace.stop_failed")));
    expect(entries).toHaveLength(1);
    expect(entries[0].actorId).toBe(bob);
    await onUserEnabled(alice);
  });

  it("people without a workspace are left alone", async () => {
    const { onUserDisabled } = await import("@/lib/sandbox/lifecycle");
    const { findSandbox } = await import("@/lib/sandbox/store");
    const { db } = await import("@/db");
    const { users } = await import("@/db/schema");
    const carol = `it-sbx-c-${suffix}`;
    await db.insert(users).values({ id: carol, upn: `${carol}@corp.local`, name: "No Sandbox", authSource: "ldap" });
    try {
      await onUserDisabled(carol, bob);
      expect(await findSandbox(carol)).toBeNull();
      expect(stub.stop).not.toHaveBeenCalled();
    } finally {
      await db.delete(users).where(eq(users.id, carol));
    }
  });

  it("the sweep destroys expired workspaces and old orphans, never a live or new one", async () => {
    const { db } = await import("@/db");
    const { sandboxes } = await import("@/db/schema");
    const { getOrCreateRef, findSandbox } = await import("@/lib/sandbox/store");
    const { sweepSandboxes } = await import("@/lib/sandbox/lifecycle");
    // A clock far in the past, so only this test's rows can count as expired.
    const now = new Date("2001-01-01T12:00:00Z");
    const aliceRef = await getOrCreateRef(alice);
    const bobRef = await getOrCreateRef(bob);
    await db.update(sandboxes).set({ deleteAfter: new Date("2001-01-01T00:00:00Z") }).where(eq(sandboxes.userId, alice));
    await db.update(sandboxes).set({ deleteAfter: new Date("2001-01-02T00:00:00Z") }).where(eq(sandboxes.userId, bob));

    const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
    const state = (ref: string, over: Partial<SandboxState>): SandboxState => ({
      ref,
      state: "stopped",
      runtime: "runsc",
      drift: false,
      createdAt: at(2 * 3_600_000),
      lastUsedAt: null,
      activeExecs: 0,
      ...over,
    });
    stub.list.mockResolvedValue([
      state(bobRef, {}), // known: kept
      state("orphanold0000000000a", {}), // orphan, 2 h old: removed
      state("orphannew0000000000b", { state: "running", createdAt: at(60_000) }), // orphan, 1 min old: kept
      state("orphanvol0000000000c", { state: "missing", createdAt: null }), // only a volume left: removed
      state("orphanbusy000000000d", { state: "running", activeExecs: 1 }), // running a command: kept
    ]);

    const r = await sweepSandboxes(now);
    expect(r).toEqual({ expired: 1, orphans: 2 });
    expect(stub.destroy.mock.calls.map((c) => c[0]).sort()).toEqual([aliceRef, "orphanold0000000000a", "orphanvol0000000000c"].sort());
    expect(await findSandbox(alice)).toBeNull();
    expect(await findSandbox(bob)).not.toBeNull();
  });

  it("a failed destroy keeps the record for the next sweep", async () => {
    const { db } = await import("@/db");
    const { sandboxes } = await import("@/db/schema");
    const { getOrCreateRef, findSandbox } = await import("@/lib/sandbox/store");
    const { sweepSandboxes } = await import("@/lib/sandbox/lifecycle");
    await getOrCreateRef(alice);
    await db.update(sandboxes).set({ deleteAfter: new Date("2001-01-01T00:00:00Z") }).where(eq(sandboxes.userId, alice));
    stub.destroy.mockRejectedValue(new Error("docker unavailable"));
    const r = await sweepSandboxes(new Date("2001-01-01T12:00:00Z"));
    expect(r.expired).toBe(0);
    expect(await findSandbox(alice)).not.toBeNull();
  });
});

run("approval responses (integration)", () => {
  const userId = `it-appr-${process.pid}-${Date.now()}`;

  beforeAll(async () => {
    const { db } = await import("@/db");
    const { users } = await import("@/db/schema");
    await db.insert(users).values({ id: userId, upn: `${userId}@corp.local`, name: "Approvals", authSource: "ldap" });
  });
  afterAll(async () => {
    const { db } = await import("@/db");
    const { users } = await import("@/db/schema");
    await db.delete(users).where(eq(users.id, userId));
  });

  it("concurrent submissions of one approval: exactly one wins, so the tool runs once", async () => {
    const { db } = await import("@/db");
    const { conversations } = await import("@/db/schema");
    const { insertMessage, updatePartsLocked, loadMessageRows } = await import("@/lib/chat/store");
    const { applyApprovalDecisions } = await import("@/lib/agent/approval-merge");
    const { newId } = await import("@/lib/ids");
    const [conv] = await db.insert(conversations).values({ id: newId(), userId, title: "IT" }).returning();
    const msgId = newId();
    await insertMessage(
      conv.id,
      {
        id: msgId,
        role: "assistant",
        parts: [{ type: "tool-workspace_bash", toolCallId: "t1", state: "approval-requested", input: { command: "make" }, approval: { id: "ap1" } }] as never,
      },
      null,
    );
    const decisions = new Map([["ap1", { approved: true }]]);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        updatePartsLocked(conv.id, msgId, (row) => {
          const { parts, changed } = applyApprovalDecisions(row.parts as { type: string }[], decisions);
          return changed ? parts : null;
        }),
      ),
    );
    expect(results.filter((r) => r?.parts).length).toBe(1);
    expect(results.filter((r) => r && !r.parts).length).toBe(5);
    const [stored] = await loadMessageRows(conv.id);
    expect((stored.parts as { state: string; approval: { approved: boolean } }[])[0]).toMatchObject({ state: "approval-responded", approval: { approved: true } });
    // Another conversation's id can't be used to reach this message.
    expect(await updatePartsLocked("someone-else", msgId, () => [])).toBeNull();
  });
});
