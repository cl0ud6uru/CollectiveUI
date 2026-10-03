import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiApps, conversations, hermesConnections, hermesProvisions } from "@/db/schema";
import { loadPrincipal, type Principal } from "@/lib/auth/groups";
import { assertAdmin, getAccessibleApp, getUsableBot, HttpError } from "@/lib/authz";
import { decrypt, encrypt } from "@/lib/crypto";
import { newId } from "@/lib/ids";
import { audit } from "@/lib/audit";
import { connectionAAD, connectionInput, isManagedHermes, secret, type ConnectionSecrets } from "./config";
import { ProfileProtocol, PROVISION_FAILURE } from "./protocol";
import { assertApprovedBot, lockBot, profileSpec } from "./bot-policy";
export { profileSpec } from "./bot-policy";

export async function registerConnection(p: Principal, raw: unknown) {
  assertAdmin(p);
  const parsed = connectionInput.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "Check the isolation confirmation, exact loopback URLs, protocol, version, provider and distinct credential values.");
  const { dashboardToken, providerKey, profileKeys, ...input } = parsed.data;
  const owner = await loadPrincipal(input.userId);
  if (!owner) throw new HttpError(400, "Select an enabled user.");
  const id = newId();
  const credentialsEnc = encrypt(JSON.stringify({ dashboardToken, providerKey, profileKeys }), connectionAAD(id));
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(632006, 12)`);
      const endpoints = [input.dashboardUrl, input.runsUrl];
      const [collision] = await tx.select({ id: hermesConnections.id }).from(hermesConnections).where(or(inArray(hermesConnections.dashboardUrl, endpoints), inArray(hermesConnections.runsUrl, endpoints))).limit(1);
      if (collision) throw new HttpError(409, "Listener already registered");
      await tx.insert(hermesConnections).values({ id, ...input, credentialsEnc, quota: profileKeys.length });
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (uniqueViolation(err)) throw new HttpError(409, "This user, boundary or listener is already registered. Connections cannot be reassigned.");
    throw new HttpError(503, "The connection could not be stored. Database service is unavailable; retry later.");
  }
  await audit(p.user.id, "hermes.connection.create", id, { userId: input.userId, quota: profileKeys.length });
  return id;
}

export async function setConnectionEnabled(p: Principal, id: string, enabled: boolean) {
  assertAdmin(p);
  await db.update(hermesConnections).set({ enabled }).where(eq(hermesConnections.id, id));
  await audit(p.user.id, enabled ? "hermes.connection.enable" : "hermes.connection.disable", id);
}

/** Refresh membership at execution time. Never inherit the older delegation path's bot-owner privileges. */
async function authorize(userId: string, botId: string, appId: string) {
  const p = await loadPrincipal(userId);
  if (!p) throw new HttpError(403, "This Hermes connection is unavailable.");
  const bot = await getUsableBot(p, botId);
  const app = await getAccessibleApp(p, appId);
  if (bot.appId !== app.id || !isManagedHermes(app)) throw new HttpError(409, "This bot's Hermes configuration changed.");
  assertApprovedBot(app, botId);
  return { p, bot, app, spec: profileSpec(app, bot) };
}

export async function assertManagedConversation(userId: string, botId: string, conversationId: string) {
  const [conv] = await db.select().from(conversations).where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)));
  if (!conv || conv.botId !== botId || conv.isGroup || conv.source !== "chat")
    throw new HttpError(403, "Automatic Hermes profiles support owned direct bot chats only.");
}

/** Reserve under the connection row lock: unique user×bot, lifetime key quota and single lease across workers. */
export async function ensureProfile(userId: string, botId: string, appId: string) {
  await authorize(userId, botId, appId);
  const reserved = await db.transaction(async (tx) => {
    const bot = await lockBot(tx, botId);
    const [app] = await tx.select().from(aiApps).where(eq(aiApps.id, appId));
    if (!app || bot.appId !== appId || !bot.enabled || !app.enabled) throw new HttpError(409, "This bot changed before provisioning.");
    assertApprovedBot(app, botId);
    const spec = profileSpec(app, bot);
    const [c] = await tx.select().from(hermesConnections).where(eq(hermesConnections.userId, userId)).for("update");
    if (!c?.enabled) throw new HttpError(503, "Your Hermes runtime is not configured or has been disabled. Ask an admin to register your isolated runtime.");
    if (c.provider !== spec.config.provider) throw new HttpError(409, "Your Hermes runtime does not support this bot's configured provider.");
    let [row] = await tx.select().from(hermesProvisions).where(and(eq(hermesProvisions.userId, userId), eq(hermesProvisions.botId, botId)));
    if (!row) {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(hermesProvisions).where(eq(hermesProvisions.connectionId, c.id));
      if (n >= c.quota) throw new HttpError(429, "Your Hermes profile quota is reached. An admin must review capacity; existing profiles and memories are retained.");
      [row] = await tx.insert(hermesProvisions).values({
        id: newId(), userId, botId, appId, connectionId: c.id, keySlot: n,
        profile: `cui-${randomUUID().replaceAll("-", "")}`, specHash: spec.hash,
      }).returning();
    }
    if (row.specHash !== spec.hash || row.appId !== appId || row.connectionId !== c.id)
      throw new HttpError(409, "This bot changed after its Hermes profile was assigned. Restore its definition or use a new bot; existing memories are retained.");
    if (row.status === "ready") return { row, spec, claimed: false };
    const [inFlight] = await tx.select({ id: hermesProvisions.id }).from(hermesProvisions).where(and(
      eq(hermesProvisions.connectionId, c.id), ne(hermesProvisions.id, row.id), eq(hermesProvisions.status, "provisioning"), gt(hermesProvisions.retryAfter, new Date()),
    )).limit(1);
    if (inFlight) throw new HttpError(409, "Another Hermes profile is being prepared for you. Retry shortly.");
    if (row.retryAfter && row.retryAfter.getTime() > Date.now())
      throw new HttpError(409, row.status === "provisioning" ? "Your Hermes profile is being prepared. Retry shortly." : (row.error ?? PROVISION_FAILURE));
    const [claimed] = await tx.update(hermesProvisions).set({ status: "provisioning", lease: newId(), attempts: row.attempts + 1,
      retryAfter: new Date(Date.now() + 300_000), updatedAt: new Date(), error: null,
    }).where(eq(hermesProvisions.id, row.id)).returning();
    return { row: claimed, spec, claimed: true };
  });
  if (!reserved.claimed) return reserved.row;
  const { row, spec } = reserved;
  try {
    const { protocol } = await protocolFor(row.id, userId, botId, appId, row.lease!);
    await protocol.prepare(row.profile, `CollectiveUI:${row.id}:${row.specHash}`, row.createAttempted, spec.config, spec.soul, row.keySlot, async () => {
      const [intent] = await db.update(hermesProvisions).set({ createAttempted: true }).where(and(eq(hermesProvisions.id, row.id), eq(hermesProvisions.lease, row.lease!))).returning({ id: hermesProvisions.id });
      if (!intent) throw new HttpError(409, "Provisioning lease changed.");
    });
    // Guard against revocation or changed bot definition during remote provisioning.
    await protocolFor(row.id, userId, botId, appId, row.lease!);
    const [ready] = await db.update(hermesProvisions).set({ status: "ready", lease: null, retryAfter: null, error: null, updatedAt: new Date() })
      .where(and(eq(hermesProvisions.id, row.id), eq(hermesProvisions.lease, row.lease!))).returning();
    if (!ready) throw new HttpError(409, "Hermes profile setup is still being reconciled. Retry shortly.");
    return ready;
  } catch (err) {
    const failure = err instanceof HttpError ? err : new HttpError(503, PROVISION_FAILURE);
    await db.update(hermesProvisions).set({ status: "failed", lease: null, retryAfter: new Date(Date.now() + 60_000), error: failure.message, updatedAt: new Date() })
      .where(and(eq(hermesProvisions.id, row.id), eq(hermesProvisions.lease, row.lease!)));
    throw failure;
  }
}

/** Reauthorize before every remote request, including approvals, SSE reconnects and stop. */
async function protocolFor(id: string, userId: string, botId: string, appId: string, lease?: string) {
  const check = async () => {
    const { spec } = await authorize(userId, botId, appId);
    const [binding] = await db.select({ row: hermesProvisions, c: hermesConnections }).from(hermesProvisions)
      .innerJoin(hermesConnections, eq(hermesConnections.id, hermesProvisions.connectionId)).where(eq(hermesProvisions.id, id));
    const { row, c } = binding ?? {};
    if (!row || row.userId !== userId || row.botId !== botId || row.appId !== appId || row.specHash !== spec.hash)
      throw new HttpError(403, "This Hermes profile is unavailable for this user and bot.");
    if (lease ? row.status !== "provisioning" || row.lease !== lease || !row.retryAfter || row.retryAfter.getTime() <= Date.now() : row.status !== "ready")
      throw new HttpError(409, "This Hermes profile is being reconciled. Retry shortly.");
    if (!c?.enabled || c.userId !== userId) throw new HttpError(403, "Your Hermes runtime has been disabled.");
    return { row, c, spec };
  };
  const { c, spec } = await check();
  let secrets: ConnectionSecrets;
  try { secrets = JSON.parse(decrypt(c.credentialsEnc, connectionAAD(c.id))) as ConnectionSecrets; }
  catch { throw new HttpError(503, PROVISION_FAILURE); }
  const transport: typeof fetch = async (input, init) => { await check(); return fetch(input, init); };
  return { protocol: new ProfileProtocol(c, secrets, transport), spec };
}

/** Never provisions on discovery, resume or cancellation; only the admitted first-use path can create. */
export async function managedTarget(userId: string, botId: string, appId: string, provisionId?: string | null, verify = false) {
  const [row] = await db.select().from(hermesProvisions).where(and(eq(hermesProvisions.userId, userId), eq(hermesProvisions.botId, botId)));
  if (!row || row.status !== "ready" || (provisionId && row.id !== provisionId)) throw new HttpError(503, "Your Hermes profile is not ready. Send a message to retry setup, or ask an admin to check the connection.");
  const { protocol, spec } = await protocolFor(row.id, userId, botId, appId);
  if (verify) {
    try { await protocol.verify(row.profile, spec.config, spec.soul, row.keySlot); }
    catch (err) { throw err instanceof HttpError ? err : new HttpError(503, PROVISION_FAILURE); }
  }
  return { target: protocol.target(row.profile, row.keySlot), approvalTimeoutSec: 300, provisionId: row.id };
}

/** Drizzle wraps driver errors; never return SQL, parameters or upstream error text. */
function uniqueViolation(err: unknown): boolean {
  for (let depth = 0; depth < 4 && err && typeof err === "object"; depth++) {
    if ("code" in err && err.code === "23505") return true;
    err = "cause" in err ? err.cause : undefined;
  }
  return false;
}

export async function rotateDashboardToken(p: Principal, id: string, token: string) {
  assertAdmin(p);
  if (!secret.safeParse(token).success) throw new HttpError(400, "Enter a valid dashboard session token.");
  await db.transaction(async (tx) => {
    const [c] = await tx.select().from(hermesConnections).where(eq(hermesConnections.id, id)).for("update");
    if (!c) throw new HttpError(404, "Connection not found");
    const secrets = JSON.parse(decrypt(c.credentialsEnc, connectionAAD(id))) as ConnectionSecrets;
    if (secrets.profileKeys.includes(token) || secrets.providerKey === token) throw new HttpError(400, "Use a distinct dashboard credential.");
    await tx.update(hermesConnections).set({ credentialsEnc: encrypt(JSON.stringify({ ...secrets, dashboardToken: token }), connectionAAD(id)) }).where(eq(hermesConnections.id, id));
  });
  await audit(p.user.id, "hermes.connection.token.rotate", id);
}
