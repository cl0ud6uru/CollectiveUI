import { and, count, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/db";
import { aiApps, architectProviderConnectionDrafts, bots, conversations, providerConnections, users } from "@/db/schema";
import { loadPrincipal, type Principal } from "@/lib/auth/groups";
import { HttpError } from "@/lib/authz";
import { auditVia } from "@/lib/audit";
import { lockArchitectActor, authorizeArchitectCall } from "@/lib/agent/tools/admin-guard";
import type { AgentCtx } from "@/lib/agent/types";
import { providerConnectionUpdatedAtToken, readProviderConnectionUpdatedAtToken, updateProviderConnectionMetadata } from "@/lib/admin/provider-connection-write";
import { safeUrl } from "@/lib/admin/secret-safe";
import { decodeSecret, encodeSecretInput, type AppSecret } from "@/lib/llm/secrets";
import { CATALOG, CONFIG_SCHEMAS, normalizeBaseUrl, type SavedProviderKind } from "@/lib/llm/catalog";
import { connectionConfig, openProviderCredential, sealProviderCredential, type ProviderConnection } from "@/lib/llm/provider-connections";
import { testConnection, type ConnectionTestResult } from "@/lib/llm/test-connection";
import { newId } from "@/lib/ids";

const timestamp = z.string().datetime({ offset: true });
export const architectProviderConnectionUpdateInput = z.object({
  connectionId: z.string().min(1).max(128), expectedUpdatedAt: timestamp,
  name: z.string().trim().min(1).max(80).optional(), enabled: z.boolean().optional(),
}).strict().refine(input => input.name !== undefined || input.enabled !== undefined, "Choose a connection name or enabled state to update.");
export const architectProviderConnectionTestInput = z.object({ connectionId: z.string().min(1).max(128), expectedUpdatedAt: timestamp }).strict();
export const architectProviderConnectionDraftInput = z.object({
  provider: z.enum(["openai", "openai-compatible", "openrouter"]).default("openai"),
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().max(500).nullable().optional(),
  organization: z.string().trim().max(100).nullable().optional(),
  project: z.string().trim().max(100).nullable().optional(),
}).strict().superRefine((input, issue) => {
  if (input.provider !== "openai" && (input.organization || input.project))
    issue.addIssue({ code: "custom", path: ["provider"], message: "Organization and project are supported only by OpenAI." });
});

const via = (ctx: AgentCtx) => ({ agent: "architect" as const, botId: ctx.bot!.id });
const checkAbort = (signal?: AbortSignal) => signal?.throwIfAborted();
const MAX_PENDING_DRAFTS = 3;

async function prepareWrite(ctx: AgentCtx, tx: Tx): Promise<Principal> {
  await lockArchitectActor(ctx, tx);
  const fresh = await authorizeArchitectCall(ctx, tx);
  if (!fresh.isAdmin) throw new HttpError(403, "Admin tools are for administrators only.");
  return fresh;
}

/** Reconstruct only the live saved Architect context; used when an admin returns to the protected form. */
async function authorizeDraftContext(tx: Tx, actorId: string, sessionVersion: number, botId: string, conversationId: string) {
  const fresh = await loadPrincipal(actorId, tx);
  if (!fresh || !fresh.isAdmin || fresh.user.sessionVersion !== sessionVersion)
    throw new HttpError(403, "Administrator access or session changed. Start a new Architect request.");
  const [[bot], [conversation]] = await Promise.all([
    tx.select().from(bots).where(eq(bots.id, botId)),
    tx.select().from(conversations).where(eq(conversations.id, conversationId)),
  ]);
  const [app] = bot?.appId ? await tx.select().from(aiApps).where(eq(aiApps.id, bot.appId)) : [];
  if (!bot || !app) throw new HttpError(403, "The Architect installation changed. Start a new request.");
  const ctx: AgentCtx = { principal: fresh, conversationId, bot, app, depth: 0, background: false, inGroup: false, toolSettings: {
    disabledTools: [], enforcedApproval: [], fetchAllowlist: [], webSearch: { provider: "none" }, maxStepsCap: 10, botCreation: "admins",
  } };
  await lockArchitectActor(ctx, tx);
  await tx.select({ id: aiApps.id }).from(aiApps).where(eq(aiApps.id, app.id)).for("share");
  if (app.providerConnectionId)
    await tx.select({ id: providerConnections.id }).from(providerConnections).where(eq(providerConnections.id, app.providerConnectionId)).for("share");
  await authorizeArchitectCall(ctx, tx);
  if (!conversation || conversation.userId !== actorId || conversation.botId !== botId || conversation.source !== "chat" || conversation.isGroup)
    throw new HttpError(403, "This credential form is no longer linked to your direct Architect conversation.");
  return { fresh, bot, app };
}

/** Create a metadata-only handoff. The credential is submitted later through the authenticated Admin form. */
export async function prepareArchitectProviderConnection(ctx: AgentCtx, _actor: Principal, raw: unknown, signal?: AbortSignal) {
  const input = architectProviderConnectionDraftInput.parse(raw);
  const normalized = normalizeBaseUrl(input.provider, input.baseUrl);
  if (!normalized.ok) throw new HttpError(400, normalized.error);
  const organization = input.organization?.trim() || null;
  const project = input.project?.trim() || null;
  const config = input.provider === "openai" ? { organization: organization ?? undefined, project: project ?? undefined } : {};
  const parsed = CONFIG_SCHEMAS[input.provider].safeParse(config);
  if (!parsed.success) throw new HttpError(400, "Provider billing selectors are invalid.");
  return db.transaction(async tx => {
    const fresh = await prepareWrite(ctx, tx);
    await tx.delete(architectProviderConnectionDrafts).where(and(eq(architectProviderConnectionDrafts.userId, fresh.user.id), or(
      isNotNull(architectProviderConnectionDrafts.consumedAt), ne(architectProviderConnectionDrafts.sessionVersion, fresh.user.sessionVersion),
      sql`${architectProviderConnectionDrafts.expiresAt} <= clock_timestamp()`,
    )));
    const [open] = await tx.select({ count: count() }).from(architectProviderConnectionDrafts).where(and(
      eq(architectProviderConnectionDrafts.userId, fresh.user.id), isNull(architectProviderConnectionDrafts.consumedAt),
      sql`${architectProviderConnectionDrafts.expiresAt} > clock_timestamp()`,
    ));
    if ((open?.count ?? 0) >= MAX_PENDING_DRAFTS) throw new HttpError(429, "Finish or wait for an existing credential form before preparing another.");
    checkAbort(signal);
    const id = newId();
    const [created] = await tx.insert(architectProviderConnectionDrafts).values({ id, userId: fresh.user.id,
      sessionVersion: fresh.user.sessionVersion, botId: ctx.bot!.id, conversationId: ctx.conversationId,
      provider: input.provider, name: input.name, baseUrl: normalized.value, organization, project,
      expiresAt: sql`clock_timestamp() + interval '15 minutes'` }).returning();
    await auditVia(fresh.user.id, via(ctx), "architect.provider_connection.prepare", id,
      { provider: input.provider, expiresAt: created.expiresAt }, tx);
    checkAbort(signal);
    return { status: "setup_required" as const, provider: input.provider,
      draftId: id, expiresAt: created.expiresAt.toISOString(),
      formPath: `/admin/apps?architectConnectionDraft=${encodeURIComponent(id)}`,
      note: "Enter the API key in the authenticated Admin form. It is never sent through this conversation." };
  });
}

/** The page displays only an owner/session-bound, unexpired draft after revalidating its Architect context. */
export async function loadArchitectProviderConnectionDraft(actorId: string, sessionVersion: number, rawId: unknown) {
  const id = z.string().min(1).max(128).safeParse(rawId);
  if (!id.success) return null;
  return db.transaction(async tx => {
    const [draft] = await tx.select().from(architectProviderConnectionDrafts).where(and(
      eq(architectProviderConnectionDrafts.id, id.data), eq(architectProviderConnectionDrafts.userId, actorId),
      eq(architectProviderConnectionDrafts.sessionVersion, sessionVersion), isNull(architectProviderConnectionDrafts.consumedAt),
      sql`${architectProviderConnectionDrafts.expiresAt} > clock_timestamp()`,
    ));
    if (!draft) return null;
    try { await authorizeDraftContext(tx, actorId, sessionVersion, draft.botId, draft.conversationId); }
    catch (error) { if (error instanceof HttpError && error.status === 403) return null; throw error; }
    return { id: draft.id, provider: draft.provider, name: draft.name, baseUrl: draft.baseUrl,
      organization: draft.organization, project: draft.project, expiresAt: draft.expiresAt.toISOString() };
  });
}

const providerDraftCompletionInput = z.object({ draftId: z.string().min(1).max(128), apiKey: z.string().min(1).max(4000) }).strict();

/** Atomically create the encrypted saved credential and consume the one-use draft. */
export async function completeArchitectProviderConnectionDraft(actorId: string, sessionVersion: number, raw: unknown) {
  const parsed = providerDraftCompletionInput.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "The credential form is invalid. Prepare a new form in The Architect.");
  const input = parsed.data;
  return db.transaction(async tx => {
    // Keep the account-first lock order used by Architect and access lifecycle writes; session revocation cannot race the handoff.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, actorId)).for("share");
    const [draft] = await tx.select().from(architectProviderConnectionDrafts).where(and(
      eq(architectProviderConnectionDrafts.id, input.draftId), eq(architectProviderConnectionDrafts.userId, actorId),
      eq(architectProviderConnectionDrafts.sessionVersion, sessionVersion), isNull(architectProviderConnectionDrafts.consumedAt),
      sql`${architectProviderConnectionDrafts.expiresAt} > clock_timestamp()`,
    )).for("update");
    if (!draft) throw new HttpError(409, "This credential form expired or was already used. Prepare a new form in The Architect.");
    const { fresh } = await authorizeDraftContext(tx, actorId, sessionVersion, draft.botId, draft.conversationId);
    const config = draft.provider === "openai" ? { organization: draft.organization ?? undefined, project: draft.project ?? undefined } : {};
    let secret: string | null;
    try { secret = encodeSecretInput(draft.provider, CONFIG_SCHEMAS[draft.provider].parse(config), { apiKey: input.apiKey }); }
    catch { throw new HttpError(400, "The API key could not be accepted. Check it and try a new credential form."); }
    if (!secret) throw new HttpError(400, "Enter an API key.");
    const connectionId = newId();
    const [created] = await tx.insert(providerConnections).values({ id: connectionId, name: draft.name, provider: draft.provider,
      baseUrl: draft.baseUrl, organization: draft.organization, project: draft.project, credentialEnc: sealProviderCredential(connectionId, secret),
      enabled: true, createdBy: actorId }).returning();
    const [consumed] = await tx.update(architectProviderConnectionDrafts).set({ consumedAt: sql`clock_timestamp()`, connectionId })
      .where(and(eq(architectProviderConnectionDrafts.id, draft.id), isNull(architectProviderConnectionDrafts.consumedAt),
        sql`${architectProviderConnectionDrafts.expiresAt} > clock_timestamp()`)).returning({ id: architectProviderConnectionDrafts.id });
    if (!consumed) throw new HttpError(409, "This credential form expired or was already used. Prepare a new form in The Architect.");
    const [readback] = await tx.select().from(providerConnections).where(eq(providerConnections.id, connectionId));
    if (!readback || readback.provider !== draft.provider || readback.name !== draft.name || readback.baseUrl !== draft.baseUrl ||
      readback.organization !== draft.organization || readback.project !== draft.project || !readback.enabled ||
      readback.createdBy !== actorId || readback.credentialEnc !== created.credentialEnc || openProviderCredential(readback) !== secret)
      throw new HttpError(409, "The saved provider connection could not be verified.");
    await auditVia(fresh.user.id, { agent: "architect", botId: draft.botId }, "architect.provider_connection.create", connectionId,
      { draftId: draft.id, provider: draft.provider, enabled: true }, tx);
    return { status: "verified" as const, id: readback.id, name: readback.name, provider: readback.provider };
  });
}

function connectionSummary(row: ProviderConnection, updatedAt: string) {
  return { id: row.id, name: row.name, provider: row.provider, baseUrl: safeUrl(row.baseUrl), organization: row.organization,
    project: row.project, enabled: row.enabled, hasCredential: true, updatedAt };
}

export async function updateArchitectProviderConnection(ctx: AgentCtx, _actor: Principal, raw: unknown, signal?: AbortSignal) {
  const input = architectProviderConnectionUpdateInput.parse(raw);
  return db.transaction(async tx => {
    const fresh = await prepareWrite(ctx, tx);
    const [current] = await tx.select().from(providerConnections).where(eq(providerConnections.id, input.connectionId)).for("update");
    if (!current) throw new HttpError(404, "Provider connection not found.");
    const currentToken = await readProviderConnectionUpdatedAtToken(tx, current.id);
    if (currentToken !== input.expectedUpdatedAt)
      throw new HttpError(409, "Provider connection changed. Read it again and request fresh approval.");
    const patch = { name: input.name ?? current.name, enabled: input.enabled ?? current.enabled };
    checkAbort(signal);
    const saved = await updateProviderConnectionMetadata(tx, current, patch, input.expectedUpdatedAt);
    const [readback] = await tx.select().from(providerConnections).where(and(eq(providerConnections.id, current.id), eq(providerConnections.updatedAt, saved.updatedAt)));
    if (!readback || readback.name !== patch.name || readback.enabled !== patch.enabled || readback.credentialEnc !== current.credentialEnc ||
      readback.provider !== current.provider || readback.baseUrl !== current.baseUrl || readback.organization !== current.organization || readback.project !== current.project)
      throw new HttpError(409, "Provider connection update could not be verified.");
    checkAbort(signal);
    await auditVia(fresh.user.id, via(ctx), "architect.provider_connection.update", current.id,
      { fields: Object.keys(input).filter(key => key !== "connectionId" && key !== "expectedUpdatedAt"), enabled: patch.enabled }, tx);
    checkAbort(signal);
    const updatedAt = await tx.select({ token: providerConnectionUpdatedAtToken }).from(providerConnections).where(eq(providerConnections.id, readback.id));
    return { status: "verified" as const, connection: connectionSummary(readback, updatedAt[0].token) };
  });
}

export async function testArchitectProviderConnection(ctx: AgentCtx, _actor: Principal, raw: unknown, signal?: AbortSignal) {
  const input = architectProviderConnectionTestInput.parse(raw);
  const snapshot = await db.transaction(async tx => {
    const fresh = await prepareWrite(ctx, tx);
    const [row] = await tx.select().from(providerConnections).where(eq(providerConnections.id, input.connectionId)).for("share");
    if (!row) throw new HttpError(404, "Provider connection not found.");
    const updatedAt = await readProviderConnectionUpdatedAtToken(tx, row.id);
    if (updatedAt !== input.expectedUpdatedAt) throw new HttpError(409, "Provider connection changed. Read it again before testing.");
    if (!row.enabled) throw new HttpError(409, "Enable the provider connection in Admin before testing it.");
    if (CATALOG[row.provider].test !== "list") throw new HttpError(400, "This saved provider does not support a metadata-only connection test.");
    checkAbort(signal);
    return { row, actorId: fresh.user.id, updatedAt };
  });

  let outcome: ConnectionTestResult;
  try {
    const plaintext = openProviderCredential(snapshot.row);
    const config = connectionConfig(snapshot.row, {});
    const secret: AppSecret = decodeSecret(snapshot.row.provider, config, plaintext);
    outcome = await testConnection({ kind: snapshot.row.provider as SavedProviderKind, name: snapshot.row.name,
      baseUrl: snapshot.row.baseUrl, config, secret, signal });
  } catch {
    outcome = { ok: false, error: "The saved connection could not be verified. Check its credential and endpoint in Admin." };
  }
  checkAbort(signal);

  await db.transaction(async tx => {
    const fresh = await prepareWrite(ctx, tx);
    const [current] = await tx.select().from(providerConnections).where(eq(providerConnections.id, snapshot.row.id)).for("share");
    if (!current || await readProviderConnectionUpdatedAtToken(tx, current.id) !== snapshot.updatedAt || !current.enabled)
      throw new HttpError(409, "Provider connection changed while it was being tested. Read it again and retry.");
    checkAbort(signal);
    await auditVia(fresh.user.id, via(ctx), "architect.provider_connection.test", current.id,
      { outcome: outcome.ok ? "verified" : "failed", modelsFound: outcome.ok ? outcome.models.length : 0 }, tx);
    checkAbort(signal);
  });

  return outcome.ok
    ? { status: "verified" as const, modelsFound: outcome.models.length, note: "The saved connection's metadata endpoint responded. Model identifiers are withheld." }
    : { status: "failed" as const, message: "The saved connection could not be verified. Check its credential and endpoint in Admin." };
}
