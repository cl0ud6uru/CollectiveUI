import { randomBytes } from "node:crypto";
import { and, eq, isNotNull, lt, or, sql } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { workspaceBotBindings, workspaceInstances, sandboxes, type SandboxRow, type WorkspaceInstanceRow } from "@/db/schema";
import { newId } from "@/lib/ids";

/** Random, lowercase alphanumeric (sandboxd's REF_RE): unlinkable to the person without this table. */
const newRef = () => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(randomBytes(20), (b) => alphabet[b % alphabet.length]).join("");
};

/** The person's sandbox ref, created on first use (concurrent first uses agree on one row). */
export async function getOrCreateRef(userId: string): Promise<string> {
  const [existing] = await db.select({ ref: sandboxes.ref }).from(sandboxes).where(eq(sandboxes.userId, userId));
  if (existing) {
    await ensureLegacyInstance(userId, existing.ref);
    return existing.ref;
  }
  await db.insert(sandboxes).values({ userId, ref: newRef() }).onConflictDoNothing({ target: sandboxes.userId });
  const [row] = await db.select({ ref: sandboxes.ref }).from(sandboxes).where(eq(sandboxes.userId, userId));
  await ensureLegacyInstance(userId, row.ref);
  return row.ref;
}

/** Keep the legacy ref and volume intact while reconciling timestamps written by older portal binaries. */
export async function ensureLegacyInstance(userId: string, ref?: string, query: DbOrTx = db): Promise<WorkspaceInstanceRow | null> {
  const [sandbox] = await query.select().from(sandboxes).where(eq(sandboxes.userId, userId));
  const sandboxRef = ref ?? sandbox?.ref;
  const matchingSandbox = sandbox?.ref === sandboxRef ? sandbox : null;
  const [legacy] = await query.select().from(workspaceInstances).where(and(
    eq(workspaceInstances.ownerUserId, userId),
    eq(workspaceInstances.origin, "legacy_personal"),
  ));
  if (legacy) {
    // Compatibility rule: while sandboxes exists, its retention and usage timestamps are authoritative for the
    // legacy instance because older portal binaries update only that row. Template instances remain independent.
    if (matchingSandbox && legacy.sandboxRef === matchingSandbox.ref) {
      await query.update(workspaceInstances).set({
        lastUsedAt: matchingSandbox.lastUsedAt,
        deleteAfter: matchingSandbox.deleteAfter,
      }).where(and(eq(workspaceInstances.ownerUserId, userId), eq(workspaceInstances.id, legacy.id)));
      const [refreshed] = await query.select().from(workspaceInstances).where(eq(workspaceInstances.id, legacy.id));
      return refreshed ?? legacy;
    }
    return legacy;
  }
  if (!sandboxRef) return null;
  await query.insert(workspaceInstances).values({
    id: newId(),
    ownerUserId: userId,
    templateVersionId: null,
    origin: "legacy_personal",
    sandboxRef,
    runtimeProfileKey: "legacy",
    provisionState: "missing",
    lastUsedAt: matchingSandbox?.lastUsedAt ?? null,
    deleteAfter: matchingSandbox?.deleteAfter ?? null,
    createdAt: matchingSandbox?.createdAt,
  }).onConflictDoNothing();
  const [created] = await query.select().from(workspaceInstances).where(and(
    eq(workspaceInstances.ownerUserId, userId),
    eq(workspaceInstances.origin, "legacy_personal"),
  ));
  if (created && matchingSandbox && created.sandboxRef === matchingSandbox.ref) {
    await query.update(workspaceInstances).set({
      lastUsedAt: matchingSandbox.lastUsedAt,
      deleteAfter: matchingSandbox.deleteAfter,
    }).where(eq(workspaceInstances.id, created.id));
    const [refreshed] = await query.select().from(workspaceInstances).where(eq(workspaceInstances.id, created.id));
    return refreshed ?? created;
  }
  return created ?? null;
}

export async function findSandbox(userId: string, query: DbOrTx = db): Promise<SandboxRow | null> {
  const [row] = await query.select().from(sandboxes).where(eq(sandboxes.userId, userId));
  return row ?? null;
}

export async function touchSandbox(userId: string) {
  const now = new Date();
  await db.update(sandboxes).set({ lastUsedAt: now }).where(eq(sandboxes.userId, userId));
  await db.update(workspaceInstances).set({ lastUsedAt: now }).where(and(
    eq(workspaceInstances.ownerUserId, userId),
    eq(workspaceInstances.origin, "legacy_personal"),
  ));
}

export async function touchWorkspaceInstance(instanceId: string, ownerUserId: string, query: DbOrTx = db) {
  const now = new Date();
  const [instance] = await query.update(workspaceInstances).set({ lastUsedAt: now }).where(and(
    eq(workspaceInstances.id, instanceId),
    eq(workspaceInstances.ownerUserId, ownerUserId),
  )).returning({ origin: workspaceInstances.origin, sandboxRef: workspaceInstances.sandboxRef });
  // Keep legacy settings/cleanup consumers coherent while the additive adapter is in place.
  if (instance?.origin === "legacy_personal") {
    await query.update(sandboxes).set({ lastUsedAt: now }).where(and(
      eq(sandboxes.userId, ownerUserId),
      eq(sandboxes.ref, instance.sandboxRef),
    ));
  }
}

/** Disabled people: keep the workspace for `days`, then the cleanup job destroys it. */
export async function markDeleteAfter(userId: string, days: number, query: DbOrTx = db) {
  const deleteAfter = new Date(Date.now() + days * 86_400_000);
  await query.update(sandboxes).set({ deleteAfter }).where(eq(sandboxes.userId, userId));
  await query.update(workspaceInstances).set({ deleteAfter }).where(eq(workspaceInstances.ownerUserId, userId));
  return deleteAfter;
}

export async function clearDeleteAfter(userId: string, query: DbOrTx = db) {
  await query.update(sandboxes).set({ deleteAfter: null }).where(eq(sandboxes.userId, userId));
  // Enabling an account preserves retirement deadlines for unused template instances.
  await query.update(workspaceInstances).set({ deleteAfter: null }).where(and(
    eq(workspaceInstances.ownerUserId, userId),
    or(eq(workspaceInstances.origin, "legacy_personal"), sql`exists (select 1 from ${workspaceBotBindings} where ${workspaceBotBindings.instanceId} = ${workspaceInstances.id})`),
  ));
}

/** With the owner lock held, persist cleanup for failed/replaced/crashed templates without extending old deadlines. */
export async function retireUnboundTemplateInstances(userId: string, days: number, query: DbOrTx = db, now = new Date()) {
  const deadline = new Date(now.getTime() + days * 86_400_000);
  await query.update(workspaceInstances).set({ deleteAfter: sql`coalesce(${workspaceInstances.deleteAfter}, ${deadline.toISOString()}::timestamptz)` }).where(and(
    eq(workspaceInstances.ownerUserId, userId), eq(workspaceInstances.origin, "template"),
    sql`not exists (select 1 from ${workspaceBotBindings} where ${workspaceBotBindings.instanceId} = ${workspaceInstances.id})`,
  ));
}

export function listSandboxRows() {
  return db.select().from(sandboxes);
}

export function expiredSandboxes(now = new Date()) {
  return db
    .select()
    .from(sandboxes)
    .where(and(isNotNull(sandboxes.deleteAfter), lt(sandboxes.deleteAfter, now)));
}

export function listWorkspaceInstances() {
  return db.select().from(workspaceInstances);
}

export function expiredWorkspaceInstances(now = new Date()) {
  return db.select().from(workspaceInstances).where(and(
    isNotNull(workspaceInstances.deleteAfter),
    lt(workspaceInstances.deleteAfter, now),
  ));
}

export async function findWorkspaceInstance(ownerUserId: string, instanceId: string, query: DbOrTx = db): Promise<WorkspaceInstanceRow | null> {
  const [row] = await query.select().from(workspaceInstances).where(and(
    eq(workspaceInstances.id, instanceId),
    eq(workspaceInstances.ownerUserId, ownerUserId),
  ));
  return row ?? null;
}

export async function findWorkspaceInstanceById(instanceId: string): Promise<WorkspaceInstanceRow | null> {
  const [row] = await db.select().from(workspaceInstances).where(eq(workspaceInstances.id, instanceId));
  return row ?? null;
}

/** Remove only the specified user's registry row and bot binding; the caller destroys its selected ref first. */
export async function forgetWorkspaceInstance(ownerUserId: string, instanceId: string, query?: DbOrTx) {
  const forget = async (tx: DbOrTx) => {
    const [row] = await tx.select().from(workspaceInstances).where(and(
      eq(workspaceInstances.ownerUserId, ownerUserId),
      eq(workspaceInstances.id, instanceId),
    ));
    if (!row) return;
    await tx.delete(workspaceBotBindings).where(and(
      eq(workspaceBotBindings.userId, ownerUserId),
      eq(workspaceBotBindings.instanceId, instanceId),
    ));
    await tx.delete(workspaceInstances).where(and(
      eq(workspaceInstances.ownerUserId, ownerUserId),
      eq(workspaceInstances.id, instanceId),
    ));
    if (row.origin === "legacy_personal") {
      await tx.delete(sandboxes).where(and(eq(sandboxes.userId, ownerUserId), eq(sandboxes.ref, row.sandboxRef)));
    }
  };
  if (query) await forget(query);
  else await db.transaction(forget);
}

export async function forgetSandbox(userId: string) {
  await db.transaction(async (tx) => {
    const [legacy] = await tx.select({ id: workspaceInstances.id }).from(workspaceInstances).where(and(
      eq(workspaceInstances.ownerUserId, userId),
      eq(workspaceInstances.origin, "legacy_personal"),
    ));
    if (legacy) {
      await tx.delete(workspaceBotBindings).where(and(
        eq(workspaceBotBindings.userId, userId),
        eq(workspaceBotBindings.instanceId, legacy.id),
      ));
      await tx.delete(workspaceInstances).where(eq(workspaceInstances.id, legacy.id));
    }
    await tx.delete(sandboxes).where(eq(sandboxes.userId, userId));
  });
}
