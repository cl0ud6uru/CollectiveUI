import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/db";
import { auditLog, localAuthBootstrap, localCredentials, localLoginAliases, users } from "@/db/schema";
import { resolvePrincipal } from "./groups";
import { localEnabled } from "./config";
import { hashPassword, validateNewPassword, validPasswordInput, verifyPassword } from "./password";
import { allowPasswordAttempt } from "./throttle";
import { hasLocalFactors } from "./factor-state";
import { HttpError } from "@/lib/authz";

export type AuthActor = { id: string; sessionVersion: number };
export const LocalUserInput = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/, "Username must be 3–64 letters, digits, dots, underscores or hyphens."),
  email: z.union([z.literal(""), z.email().max(254)]).optional().transform(v => v?.trim().toLowerCase() || null),
  name: z.string().trim().min(1).max(100),
  password: z.string(),
  isAdmin: z.boolean().default(false),
}).strict();
function enabled() { if (!localEnabled()) throw new HttpError(403, "Local accounts are disabled"); }
// All local lifecycle and role mutations use this same transaction lock, including bootstrap/recovery.
export async function lockAccounts(tx: Tx) { await tx.execute(sql`SELECT pg_advisory_xact_lock(632006, 11)`); }
async function auditTx(tx: Tx, actorId: string | null, action: string, target: string) {
  await tx.insert(auditLog).values({ actorId, action, target });
}
async function assertActor(tx: Tx, actor: AuthActor) {
  const [user] = await tx.select().from(users).where(eq(users.id, actor.id));
  if (!user || user.disabled || user.sessionVersion !== actor.sessionVersion || !(await resolvePrincipal(user, tx)).isAdmin) throw new HttpError(403, "Admin only");
  if (user.identityRealm === "local") {
    const [credential] = await tx.select().from(localCredentials).where(eq(localCredentials.userId, user.id));
    if (!localEnabled() || !credential || credential.mustChangePassword) throw new HttpError(403, "Admin only");
  }
}
export async function createLocalUser(raw: unknown, actor: AuthActor | "bootstrap") {
  enabled();
  const input = LocalUserInput.safeParse(raw);
  if (!input.success) throw new HttpError(400, input.error.issues.map(i => i.message).join(" "));
  const v = input.data;
  validateNewPassword(v.password);
  const passwordHash = await hashPassword(v.password);
  try {
    return await db.transaction(async tx => {
      await lockAccounts(tx);
      if (actor === "bootstrap") {
        if (process.env.LOCAL_AUTH_OPERATOR !== "bootstrap") throw new HttpError(403, "Operator bootstrap not enabled");
        const existing = await tx.select({ id: localCredentials.userId }).from(localCredentials).limit(1);
        const marker = await tx.select().from(localAuthBootstrap);
        if (existing.length || marker.length) throw new HttpError(409, "Local authentication is already initialized; use recovery if needed.");
        await tx.insert(localAuthBootstrap).values({ id: 1 });
      } else await assertActor(tx, actor);
      const [user] = await tx.insert(users).values({
        upn: `local:${v.username}`, identityRealm: "local", authSource: "local", name: v.name, email: v.email,
        isAdmin: actor === "bootstrap" || v.isAdmin,
      }).returning();
      await tx.insert(localCredentials).values({ userId: user.id, username: v.username, passwordHash,
        mustChangePassword: actor !== "bootstrap", temporaryExpiresAt: actor === "bootstrap" ? null : new Date(Date.now() + 86400000) });
      await tx.insert(localLoginAliases).values([...new Set([v.username, ...(v.email ? [v.email] : [])])].map(login => ({ login, userId: user.id })));
      await auditTx(tx, actor === "bootstrap" ? null : actor.id, actor === "bootstrap" ? "local.bootstrap" : "local.create", user.id);
      return { id: user.id };
    });
  } catch (err) {
    const code = (err as { cause?: { code?: string }; code?: string }).cause?.code ?? (err as { code?: string }).code;
    if (code === "23505") throw new HttpError(409, "That local username or email is already in use.");
    throw err;
  }
}
export async function authenticateLocalPassword(username: unknown, password: unknown, headers: Headers) {
  if (!localEnabled() || typeof username !== "string" || username.length > 254 || !validPasswordInput(password)) return null;
  const login = username.trim().toLowerCase();
  const [row] = await db.select({ user: users, credential: localCredentials }).from(localLoginAliases)
    .innerJoin(localCredentials, eq(localCredentials.userId, localLoginAliases.userId))
    .innerJoin(users, eq(users.id, localCredentials.userId)).where(eq(localLoginAliases.login, login));
  // Both username and email consume the same account bucket. Unknown identifiers receive identical handling.
  if (!await allowPasswordAttempt("local", row?.user.id ?? login, headers)) return null;
  const matches = await verifyPassword(password, row?.credential.passwordHash);
  if (!matches || !row || row.user.disabled || row.user.identityRealm !== "local" ||
    (row.credential.temporaryExpiresAt && row.credential.temporaryExpiresAt <= new Date())) return null;
  // Bind the result to the version that was read BEFORE hashing. A concurrent reset/disable can't mint a fresh session.
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, row.user.id));
  return { id: row.user.id, name: row.user.name, email: row.user.email, sessionVersion: row.user.sessionVersion };
}
/** Legacy/direct credentials path must never bypass an enrolled factor. Version checks close enrollment races. */
export async function authenticateLocal(username: unknown, password: unknown, headers: Headers) {
  const user = await authenticateLocalPassword(username, password, headers);
  return user && !await hasLocalFactors(user.id) ? user : null;
}
async function ensureLocalAdminRemains(tx: Tx, userId: string) {
  const rows = await tx.select({ id: users.id }).from(users).innerJoin(localCredentials, eq(localCredentials.userId, users.id))
    .where(and(eq(users.identityRealm, "local"), eq(users.isAdmin, true), eq(users.disabled, false), eq(localCredentials.mustChangePassword, false), sql`${users.id} <> ${userId}`));
  if (!rows.length) throw new HttpError(400, "Keep another enabled local administrator with a permanent password before changing this account.");
}
export async function changeUserAccess(actor: AuthActor, userId: string, change: { isAdmin?: boolean; disabled?: boolean; revoke?: boolean }) {
  await db.transaction(async tx => {
    await lockAccounts(tx);
    await assertActor(tx, actor);
    const [user] = await tx.select().from(users).where(eq(users.id, userId));
    if (!user) throw new HttpError(404, "User not found");
    if (actor.id === userId && (change.isAdmin === false || change.disabled === true)) throw new HttpError(400, "You can't remove your own access here");
    if (user.identityRealm === "local" && user.isAdmin && !user.disabled && (change.isAdmin === false || change.disabled === true)) await ensureLocalAdminRemains(tx, userId);
    await tx.update(users).set({ ...(change.isAdmin === undefined ? {} : { isAdmin: change.isAdmin }), ...(change.disabled === undefined ? {} : { disabled: change.disabled }), sessionVersion: sql`${users.sessionVersion} + 1`, authChangedAt: sql`clock_timestamp()` }).where(eq(users.id, userId));
    await auditTx(tx, actor.id, change.revoke ? "user.revoke_sessions" : "user.access_changed", userId);
  });
}
export async function resetLocalPassword(actor: AuthActor | "recover-admin", userId: string, password: string) {
  enabled();
  validateNewPassword(password);
  const passwordHash = await hashPassword(password);
  await db.transaction(async tx => {
    await lockAccounts(tx);
    const [user] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.identityRealm, "local")));
    if (!user) throw new HttpError(404, "Local user not found");
    if (actor === "recover-admin") {
      if (process.env.LOCAL_AUTH_OPERATOR !== "recover-admin" || !user.isAdmin) throw new HttpError(403, "Recovery requires an existing local administrator and the operator recovery flag");
    } else {
      await assertActor(tx, actor);
      if (actor.id === userId) throw new HttpError(400, "Use Change password for your own account");
      // A reset makes a temporary credential; don't strand the only working local admin.
      if (user.isAdmin && !user.disabled) await ensureLocalAdminRemains(tx, userId);
    }
    await tx.update(localCredentials).set({ passwordHash, mustChangePassword: actor !== "recover-admin",
      temporaryExpiresAt: actor === "recover-admin" ? null : new Date(Date.now() + 86400000), updatedAt: new Date() }).where(eq(localCredentials.userId, userId));
    await tx.update(users).set({ sessionVersion: sql`${users.sessionVersion} + 1`, authChangedAt: sql`clock_timestamp()`, ...(actor === "recover-admin" ? { disabled: false } : {}) }).where(eq(users.id, userId));
    await auditTx(tx, actor === "recover-admin" ? null : actor.id, actor === "recover-admin" ? "local.operator_recovery" : "local.password_reset", userId);
  });
}
export async function changeOwnPassword(actor: AuthActor, current: unknown, password: unknown, headers: Headers) {
  enabled();
  if (!await allowPasswordAttempt("change", actor.id, headers)) throw new HttpError(400, "Unable to change password. Try again later.");
  validateNewPassword(password);
  const [credential] = await db.select().from(localCredentials).where(eq(localCredentials.userId, actor.id));
  if (!credential || !await verifyPassword(current, credential.passwordHash)) throw new HttpError(400, "Unable to change password. Check your current password.");
  if (current === password) throw new HttpError(400, "Choose a different password.");
  const passwordHash = await hashPassword(password);
  await db.transaction(async tx => {
    await lockAccounts(tx);
    const [user] = await tx.select().from(users).where(eq(users.id, actor.id));
    if (!user || user.disabled || user.identityRealm !== "local" || user.sessionVersion !== actor.sessionVersion) throw new HttpError(401, "Sign in again");
    if (await hasLocalFactors(actor.id, tx)) throw new HttpError(403, "Use Account Security to verify your factors before changing your password.");
    await tx.update(localCredentials).set({ passwordHash, mustChangePassword: false, temporaryExpiresAt: null, updatedAt: new Date() }).where(eq(localCredentials.userId, actor.id));
    await tx.update(users).set({ sessionVersion: sql`${users.sessionVersion} + 1`, authChangedAt: sql`clock_timestamp()` }).where(eq(users.id, actor.id));
    await auditTx(tx, actor.id, "local.password_changed", actor.id);
  });
}

/** Navigation after successful sign-in only; authorization independently reads sessionState on every request. */
export async function localPasswordChangeRequired(login: string) {
  const [row] = await db.select({ required: localCredentials.mustChangePassword }).from(localLoginAliases)
    .innerJoin(localCredentials, eq(localCredentials.userId, localLoginAliases.userId))
    .where(eq(localLoginAliases.login, login.trim().toLowerCase()));
  return row?.required ?? true;
}
