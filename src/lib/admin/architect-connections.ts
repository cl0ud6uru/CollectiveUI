import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/db";
import { providerConnections } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { HttpError } from "@/lib/authz";
import { auditVia } from "@/lib/audit";
import { lockArchitectActor, authorizeArchitectCall } from "@/lib/agent/tools/admin-guard";
import type { AgentCtx } from "@/lib/agent/types";
import { providerConnectionUpdatedAtToken, readProviderConnectionUpdatedAtToken, updateProviderConnectionMetadata } from "@/lib/admin/provider-connection-write";
import { safeUrl } from "@/lib/admin/secret-safe";
import { decodeSecret, type AppSecret } from "@/lib/llm/secrets";
import { CATALOG, type SavedProviderKind } from "@/lib/llm/catalog";
import { connectionConfig, openProviderCredential, type ProviderConnection } from "@/lib/llm/provider-connections";
import { testConnection, type ConnectionTestResult } from "@/lib/llm/test-connection";

const timestamp = z.string().datetime({ offset: true });
export const architectProviderConnectionUpdateInput = z.object({
  connectionId: z.string().min(1).max(128), expectedUpdatedAt: timestamp,
  name: z.string().trim().min(1).max(80).optional(), enabled: z.boolean().optional(),
}).strict().refine(input => input.name !== undefined || input.enabled !== undefined, "Choose a connection name or enabled state to update.");
export const architectProviderConnectionTestInput = z.object({ connectionId: z.string().min(1).max(128), expectedUpdatedAt: timestamp }).strict();

const via = (ctx: AgentCtx) => ({ agent: "architect" as const, botId: ctx.bot!.id });
const checkAbort = (signal?: AbortSignal) => signal?.throwIfAborted();

async function prepareWrite(ctx: AgentCtx, tx: Tx): Promise<Principal> {
  await lockArchitectActor(ctx, tx);
  const fresh = await authorizeArchitectCall(ctx, tx);
  if (!fresh.isAdmin) throw new HttpError(403, "Admin tools are for administrators only.");
  return fresh;
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
