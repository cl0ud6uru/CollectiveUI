import { randomBytes } from "node:crypto";
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { db } from "@/db";
import { sandboxes, type SandboxRow } from "@/db/schema";

/** Random, lowercase alphanumeric (sandboxd's REF_RE): unlinkable to the person without this table. */
const newRef = () => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(randomBytes(20), (b) => alphabet[b % alphabet.length]).join("");
};

/** The person's sandbox ref, created on first use (concurrent first uses agree on one row). */
export async function getOrCreateRef(userId: string): Promise<string> {
  const [existing] = await db.select({ ref: sandboxes.ref }).from(sandboxes).where(eq(sandboxes.userId, userId));
  if (existing) return existing.ref;
  await db.insert(sandboxes).values({ userId, ref: newRef() }).onConflictDoNothing({ target: sandboxes.userId });
  const [row] = await db.select({ ref: sandboxes.ref }).from(sandboxes).where(eq(sandboxes.userId, userId));
  return row.ref;
}

export async function findSandbox(userId: string): Promise<SandboxRow | null> {
  const [row] = await db.select().from(sandboxes).where(eq(sandboxes.userId, userId));
  return row ?? null;
}

export async function touchSandbox(userId: string) {
  await db.update(sandboxes).set({ lastUsedAt: new Date() }).where(eq(sandboxes.userId, userId));
}

/** Disabled people: keep the workspace for `days`, then the cleanup job destroys it. */
export async function markDeleteAfter(userId: string, days: number) {
  await db
    .update(sandboxes)
    .set({ deleteAfter: new Date(Date.now() + days * 86_400_000) })
    .where(eq(sandboxes.userId, userId));
}

export async function clearDeleteAfter(userId: string) {
  await db.update(sandboxes).set({ deleteAfter: null }).where(eq(sandboxes.userId, userId));
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

export async function forgetSandbox(userId: string) {
  await db.delete(sandboxes).where(eq(sandboxes.userId, userId));
}
