"use server";

import { deletePortalGroup, savePortalGroup, type GroupInput } from "@/lib/admin/groups";

import { nativeSearchSettingsSchema, NATIVE_SEARCH_DEFAULTS } from "@/lib/native-search-policy";

import { isManagedHermes } from "@/lib/hermes-provisioning/config";
import { remoteHermesSettingsSchema } from "@/lib/remote-hermes/policy";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { aiApps, appAccess, bots, mcpServerAccess, mcpServers, providerConnections, auditLog } from "@/db/schema";
import { getAccessibleModel, HttpError } from "@/lib/authz";
import { assertDefaultBot } from "@/lib/chat/targets";
import { saveLoginPet as storeLoginPet } from "@/lib/branding/login-pet";
import { BrandingInput } from "@/lib/branding/shared";
import { botDefaultSchema, type BotPetDefault } from "@/lib/pets/shared";
import { audit } from "@/lib/audit";
import { AAD, encrypt } from "@/lib/crypto";
import { changeUserAccess } from "@/lib/auth/local";
import { assertAuthOrigin } from "@/lib/auth/origin";
import { headers } from "next/headers";
import { newId } from "@/lib/ids";
import { testConnection } from "@/lib/llm";
import { testChatGPTConnection } from "@/lib/llm/chatgpt/models";
import { assertCreatableProvider, planAppWrite, planConnectionTest } from "@/lib/llm/app-form";
import { AppInput as AppInputSchema, CATALOG, CredentialsInput, isEligibleEmbeddingApp, isEligibleUtilityApp, isEnabledKind, type AppInput } from "@/lib/llm/catalog";
import { checkHermesUrl } from "@/lib/llm/providers/hermes";
import { activeProviderConnection, assertConnectionTarget, connectionConfig, openProviderCredential } from "@/lib/llm/provider-connections";
import { decodeSecret, sealAppSecret } from "@/lib/llm/secrets";
import { DEFAULT_IDENTITY_HEADER, newIdentitySecret, sealIdentitySecret, validIdentityHeader } from "@/lib/mcp/identity";
import { MAX_IMPORT_CHARS, parseMcpConfig } from "@/lib/mcp/import";
import { acceptMcpDrift, refreshMcpServer } from "@/lib/mcp/servers";
import { checkMcpUrl } from "@/lib/mcp/url";
import { parseHeadersInput } from "@/lib/secret-input";
import { requireAdmin } from "@/lib/session";
import { deleteAllChatGPTConnections, deleteChatGPTConnection } from "@/lib/llm/chatgpt/store";
import { sandboxd } from "@/lib/sandbox/client";
import { onUserDisabled, onUserEnabled } from "@/lib/sandbox/lifecycle";
import { findSandbox, forgetSandbox, listSandboxRows } from "@/lib/sandbox/store";
import {
  getSetting,
  setSetting,
  type BrandingSettings,
  type ChatGPTSettings,
  type LimitsSettings,
  type RemoteHermesSettings,
  type SandboxSettings,
  type ToolSettings,
} from "@/lib/settings";

const done = () => revalidatePath("/", "layout");

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

export type { AppInput } from "@/lib/llm/catalog";

export async function saveApp(raw: AppInput) {
  const p = await requireAdmin();
  const input = AppInputSchema.parse(raw);
  const result = await db.transaction(async (tx) => {
    const [existing] = input.id ? await tx.select().from(aiApps).where(eq(aiApps.id, input.id)).for("update") : [];
    if (input.id && !existing) throw new HttpError(404, "App not found");
    if (existing?.providerConfig.managed !== undefined || existing?.providerConfig.local !== undefined || existing?.providerConfig.docker !== undefined) throw new HttpError(400, "Manage local and automatic Hermes runtimes in Admin → Hermes. Their bindings are immutable.");
    assertCreatableProvider(input.provider, { chatgptEnabled: (await getSetting("chatgpt", tx)).enabled, existingProvider: existing?.provider });
    const connectionId = input.providerConnectionId === undefined && input.provider === existing?.provider
      ? existing.providerConnectionId : input.providerConnectionId;
    const [connection] = connectionId ? await tx.select().from(providerConnections).where(eq(providerConnections.id, connectionId)).for("share") : [];
    if (connectionId && !connection) throw new HttpError(404, "Provider connection not found");
    if (connection) {
      assertConnectionTarget(connection, input.provider, input.baseUrl, input.config);
      if (Object.values(input.credentials).some(v => v?.trim())) throw new HttpError(400, "Rotate the credential on the saved provider connection instead.");
      if (!connection.enabled && existing?.providerConnectionId !== connection.id) throw new HttpError(409, "This provider connection is disabled.");
    }
    const plan = connection ? { baseUrl: connection.baseUrl, providerConfig: connectionConfig(connection, input.config), secret: null }
      : planAppWrite(input, existing);
    const appId = input.id ?? newId();
    // ChatGPT apps run on each person's own plan: no company credentials, no embeddings, no sampling settings.
    const personal = input.provider === "chatgpt";
    // Hermes profiles run their own model and tools: no sampling settings or embeddings, and they can always host a bot.
    const hermes = input.provider === "hermes";
    if (hermes) {
      const problem = await checkHermesUrl(plan.baseUrl ?? "");
      if (problem) throw new HttpError(400, problem);
    }
    const values = {
      name: input.name,
      description: input.description,
      icon: input.icon,
      kind: "model" as const,
      provider: input.provider,
      providerConnectionId: connection?.id ?? null,
      providerConfig: plan.providerConfig,
      credentialMode: personal ? ("user" as const) : ("org" as const),
      baseUrl: plan.baseUrl,
      model: input.model,
      systemPrompt: input.systemPrompt,
      temperature: personal || hermes ? null : input.temperature,
      maxTokens: personal || hermes ? null : input.maxTokens,
      supportsVision: hermes ? false : input.supportsVision,
      supportsTools: hermes ? true : input.supportsTools,
      embeddingModel: personal || hermes ? null : input.embeddingModel?.trim() || null,
      isPublic: input.isPublic,
      enabled: input.enabled,
      sortOrder: input.sortOrder,
      updatedAt: new Date(),
      ...(plan.secret === undefined ? {} : { apiKeyEnc: plan.secret === null ? null : sealAppSecret(appId, plan.secret) }),
    };
    if (existing) await tx.update(aiApps).set(values).where(eq(aiApps.id, appId));
    else await tx.insert(aiApps).values({ id: appId, ...values });
    await tx.delete(appAccess).where(eq(appAccess.appId, appId));
    if (!input.isPublic && input.groupIds.length) await tx.insert(appAccess).values(input.groupIds.map((g) => ({ appId, groupId: g })));
    await tx.insert(auditLog).values({ actorId: p.user.id, action: existing ? "app.update" : "app.create", target: appId, details: { name: input.name, provider: input.provider, baseUrl: plan.baseUrl } });
    // A new Hermes profile shows up under Bots straight away (edit or delete the bot like any other).
    let botId: string | undefined;
    if (hermes && !existing) {
      const profile = (plan.providerConfig as { profile?: string }).profile || "default";
      [{ id: botId }] = await tx
        .insert(bots)
        .values({
          ownerId: p.user.id,
          name: input.name,
          avatar: hermesAvatar(profile),
          label: "Hermes",
          description: input.description?.trim() || `Hermes profile "${profile}"`,
          instructions: "",
          appId,
          visibility: input.isPublic ? "org" : "private",
        })
        .returning({ id: bots.id });
      await tx.insert(auditLog).values({ actorId: p.user.id, action: "bot.create", target: botId, details: { name: input.name, from: "hermes-app" } });
    }
    return { id: appId, botId };
  });
  done();
  return result;
}

/** A stable blob face per Hermes profile (Hermes' own Bot Mode also derives its default face from the name). */
function hermesAvatar(profile: string): string {
  const shapes = ["circle", "triangle", "egg", "hexagon", "ghost", "drop", "pill"];
  const colors = ["purple", "pink", "orange", "teal", "yellow", "blue", "red"];
  let h = 0;
  for (const ch of profile) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `blob:${shapes[h % shapes.length]}:${colors[Math.floor(h / shapes.length) % colors.length]}`;
}

export async function deleteApp(id: string) {
  const p = await requireAdmin();
  await db.transaction(async (tx) => {
    const [app] = await tx.select().from(aiApps).where(eq(aiApps.id, id)).for("update");
    if (app && (isManagedHermes(app) || app.providerConfig.local !== undefined || app.providerConfig.docker !== undefined)) throw new HttpError(409, "Managed and local Hermes connections preserve profile and cancellation bindings. Disable the bot or runtime instead of deleting its connection.");
    await tx.delete(aiApps).where(eq(aiApps.id, id));
  });
  await audit(p.user.id, "app.delete", id);
  done();
}

const ConnectionTestInput = z.object({
  providerConnectionId: z.string().min(1).max(100).nullable().optional(),
  id: z.string().optional(),
  provider: z.string(),
  name: z.string().max(80).optional(),
  baseUrl: z.string().max(500).nullable().optional(),
  model: z.string().trim().max(200).optional(),
  config: z.record(z.string(), z.unknown()).default({}),
  credentials: CredentialsInput,
});
export type ConnectionTestInput = z.input<typeof ConnectionTestInput>;

/**
 * "Test connection": lists models or sends one tiny request, using the entered credentials or — only when the
 * endpoint is unchanged — the stored ones.
 */
export async function testAppConnection(raw: ConnectionTestInput) {
  const p = await requireAdmin();
  const input = ConnectionTestInput.parse(raw);
  if (input.providerConnectionId && input.provider !== "openai") return { ok: false as const, error: "Saved provider connections support OpenAI API models only." };
  // ChatGPT apps: list what the admin's own connected plan offers (there are no app credentials to test).
  if (input.provider === "chatgpt") return testChatGPTConnection(p.user.id, await getSetting("chatgpt"));
  if (!isEnabledKind(input.provider)) return { ok: false as const, error: "Unknown provider" };
  const kind = input.provider;
  const [existing] = input.id ? await db.select().from(aiApps).where(eq(aiApps.id, input.id)) : [];
  try {
    const connectionId = input.providerConnectionId === undefined && kind === existing?.provider ? existing.providerConnectionId : input.providerConnectionId;
    if (connectionId) {
      const connection = await activeProviderConnection(connectionId);
      assertConnectionTarget(connection, kind, input.baseUrl, input.config);
      if (Object.values(input.credentials).some(v => v?.trim())) throw new HttpError(400, "Rotate the credential on the saved provider connection instead.");
      const config = connectionConfig(connection, input.config);
      let plaintext: string;
      try { plaintext = openProviderCredential(connection); } catch { throw new HttpError(400, "The saved credential could not be decrypted."); }
      return await testConnection({ kind, name: input.name || CATALOG[kind].label, model: input.model || undefined, baseUrl: connection.baseUrl, config,
        secret: decodeSecret(kind, config, plaintext) });
    }
    const plan = planConnectionTest(kind, input.config, input.baseUrl, input.credentials, existing);
    return await testConnection({ kind, name: input.name || CATALOG[kind].label, model: input.model || undefined, ...plan });
  } catch (err) {
    if (err instanceof HttpError) return { ok: false as const, error: err.message };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export type { GroupInput } from "@/lib/admin/groups";

export async function saveGroup(raw: GroupInput) {
  const p = await requireAdmin();
  const groupId = await savePortalGroup(raw, p.user.id);
  await audit(p.user.id, raw.id ? "group.update" : "group.create", groupId, { name: raw.name, isAdmin: raw.isAdmin, mappings: raw.mappings.length, directMembers: raw.memberIds?.length });
  done();
}

export async function deleteGroup(id: string) {
  const p = await requireAdmin();
  await deletePortalGroup(id, p.user.id);
  await audit(p.user.id, "group.delete", id);
  done();
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function setUserAdmin(userId: string, isAdmin: boolean) {
  const p = await requireAdmin();
  if (userId === p.user.id && !isAdmin) throw new HttpError(400, "You can't remove your own admin grant here");
  assertAuthOrigin(await headers());
  await changeUserAccess(p.user, z.string().min(1).max(100).parse(userId), { isAdmin: z.boolean().parse(isAdmin) });
  await audit(p.user.id, isAdmin ? "user.grant_admin" : "user.revoke_admin", userId);
  done();
}

export async function setUserDisabled(userId: string, disabled: boolean) {
  const p = await requireAdmin();
  if (userId === p.user.id) throw new HttpError(400, "You can't disable yourself");
  assertAuthOrigin(await headers());
  await changeUserAccess(p.user, z.string().min(1).max(100).parse(userId), { disabled: z.boolean().parse(disabled) });
  // A disabled account's own ChatGPT sign-in is revoked, not just left unusable; its workspace is stopped and
  // scheduled for deletion (re-enabling cancels that).
  if (disabled) {
    await deleteChatGPTConnection(userId);
    await onUserDisabled(userId, p.user.id);
  } else await onUserEnabled(userId);
  await audit(p.user.id, disabled ? "user.disable" : "user.enable", userId);
  done();
}

// ---------------------------------------------------------------------------
// Bots (admin oversight)
// ---------------------------------------------------------------------------

export async function setBotEnabled(botId: string, enabled: boolean) {
  const p = await requireAdmin();
  let teamChanged = false;
  await db.transaction(async tx => {
    const [bot] = await tx.select().from(bots).where(eq(bots.id, botId)).for('update');
    if (bot?.hermesTeam) {
      teamChanged = true;
      const { authorizeTeam } = await import('@/lib/hermes-team/store');
      await authorizeTeam(p, botId, 'admin', tx, true);
    }
    await tx.update(bots).set({ enabled, revision: sql`${bots.revision} + 1`, publishedRevision: null, publishedConfigHash: null }).where(eq(bots.id, botId));
    if (bot?.hermesTeam) {
      const { queueTeamAccessReconciliation } = await import('@/lib/hermes-team/revocation');
      await queueTeamAccessReconciliation(tx, botId, p.user.id, { reason: 'bot_disabled' });
    }
  });
  if (teamChanged) {
    const { reconcileTeamAccess } = await import('@/lib/hermes-team/revocation');
    await reconcileTeamAccess(botId);
  }
  await audit(p.user.id, enabled ? "bot.enable" : "bot.disable", botId);
  done();
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

const McpInput = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).nullable().optional(),
  url: z.string().url(),
  transport: z.enum(["http", "sse"]),
  headers: z.string().max(8000).optional(), // JSON object; "" = keep existing
  isPublic: z.boolean(),
  groupIds: z.array(z.string()).default([]),
  trust: z.enum(["untrusted", "trusted"]).default("untrusted"),
  /** Send the signed per-user identity header. */
  identity: z.boolean().default(false),
  identityHeader: z.string().trim().max(64).optional(),
  resultBudgetKb: z.number().int().min(1).max(1024).default(64),
  timeoutSec: z.number().int().min(1).max(600).default(60),
  toolPolicy: z
    .record(z.string().max(128), z.object({ enabled: z.boolean().optional(), requireApproval: z.boolean().optional() }))
    .refine((p) => Object.keys(p).length <= 500, "Too many tools")
    .optional(),
});
export type McpInput = z.input<typeof McpInput>;

/**
 * Saves a server. New servers start as drafts (Test, then Enable). Changing the URL or transport makes it a
 * different server: it goes back to draft, its tool list is cleared, and a new identity secret is issued so the
 * old one never reaches the new host. A new identity secret is returned once, to configure on the MCP server.
 */
export async function saveMcpServer(raw: McpInput): Promise<{ id: string; identitySecret?: string }> {
  const p = await requireAdmin();
  const input = McpInput.parse(raw);
  const problem = await checkMcpUrl(input.url);
  if (problem) throw new HttpError(400, problem);
  const identityHeader = input.identity ? input.identityHeader || DEFAULT_IDENTITY_HEADER : null;
  if (identityHeader && !validIdentityHeader(identityHeader)) throw new HttpError(400, `"${identityHeader}" can't be used as the identity header`);
  const headers = parseHeadersInput(input.headers);
  const headersEnc =
    headers.action === "set" ? encrypt(JSON.stringify(headers.headers), AAD.mcpHeaders) : headers.action === "clear" ? null : undefined;

  const [existing] = input.id ? await db.select().from(mcpServers).where(eq(mcpServers.id, input.id)) : [];
  if (input.id && !existing) throw new HttpError(404, "Not found");
  const id = existing?.id ?? newId();
  const moved = !!existing && (existing.url !== input.url || existing.transport !== input.transport);
  const identitySecret = identityHeader && (!existing?.identitySecretEnc || moved) ? newIdentitySecret() : undefined;

  const values = {
    name: input.name,
    description: input.description,
    url: input.url,
    transport: input.transport,
    isPublic: input.isPublic,
    trust: input.trust,
    identityHeader,
    resultBudgetKb: input.resultBudgetKb,
    timeoutMs: input.timeoutSec * 1000,
    policyRevision: existing ? sql`${mcpServers.policyRevision} + 1` : 1,
    ...(input.toolPolicy ? { toolPolicy: input.toolPolicy } : {}),
    ...(headersEnc !== undefined ? { headersEnc } : {}),
    ...(identitySecret ? { identitySecretEnc: sealIdentitySecret(id, identitySecret) } : identityHeader ? {} : { identitySecretEnc: null }),
    ...(moved ? { status: "draft" as const, toolsSnapshot: null, toolsHash: null, toolsDrift: null, serverInfo: null, lastTestedAt: null, lastError: null } : {}),
  };
  await db.transaction(async (tx) => {
    if (existing) await tx.update(mcpServers).set(values).where(eq(mcpServers.id, id));
    else await tx.insert(mcpServers).values({ id, ...values, status: "draft" });
    await tx.delete(mcpServerAccess).where(eq(mcpServerAccess.serverId, id));
    if (!input.isPublic && input.groupIds.length) await tx.insert(mcpServerAccess).values(input.groupIds.map((g) => ({ serverId: id, groupId: g })));
  });
  await audit(p.user.id, existing ? "mcp.update" : "mcp.create", id, {
    name: input.name,
    url: input.url,
    trust: input.trust,
    identity: !!identityHeader,
    ...(moved ? { movedToDraft: true } : {}),
    ...(identitySecret ? { identitySecretIssued: true } : {}),
  });
  done();
  return { id, ...(identitySecret ? { identitySecret } : {}) };
}

export async function deleteMcpServer(id: string) {
  const p = await requireAdmin();
  await db.delete(mcpServers).where(eq(mcpServers.id, id));
  await audit(p.user.id, "mcp.delete", id);
  done();
}

/** Test: connect, list the tools and record them (the first list is captured; later differences wait for review). */
export async function testMcpServer(id: string) {
  const p = await requireAdmin();
  const r = await refreshMcpServer(id, p.user.id);
  done();
  if (!r.ok) return { ok: false as const, error: r.error };
  return { ok: true as const, result: r.result, tools: r.tools.map((t) => t.name), drift: r.drift ? { added: r.drift.added, changed: r.drift.changed, removed: r.drift.removed } : null };
}

/** Enable needs a captured tool list (Test first); bots only ever see tools from it. */
export async function setMcpServerEnabled(id: string, enabled: boolean) {
  const p = await requireAdmin();
  const [server] = await db.select().from(mcpServers).where(eq(mcpServers.id, id));
  if (!server) throw new HttpError(404, "Not found");
  if (enabled && !server.toolsSnapshot) throw new HttpError(400, "Test the server first, so its tool list can be reviewed.");
  const status = !enabled ? "disabled" : server.toolsDrift ? "needs_review" : "enabled";
  await db.update(mcpServers).set({ status, policyRevision: sql`${mcpServers.policyRevision} + 1` }).where(eq(mcpServers.id, id));
  await audit(p.user.id, enabled ? "mcp.enable" : "mcp.disable", id, { name: server.name });
  done();
}

export async function acceptMcpToolChanges(id: string, hash: string) {
  const p = await requireAdmin();
  const r = await acceptMcpDrift(id, z.string().max(128).parse(hash));
  if (!r.ok) throw new HttpError(409, r.error);
  await audit(p.user.id, "mcp.accept_changes", id);
  done();
}

/** Issues a new identity secret (the old one stops working at once). Returned once. */
export async function rotateMcpIdentitySecret(id: string): Promise<{ identitySecret: string }> {
  const p = await requireAdmin();
  const [server] = await db.select().from(mcpServers).where(eq(mcpServers.id, id));
  if (!server) throw new HttpError(404, "Not found");
  if (!server.identityHeader) throw new HttpError(400, "Turn on the identity header first");
  const identitySecret = newIdentitySecret();
  await db.update(mcpServers).set({ identitySecretEnc: sealIdentitySecret(id, identitySecret), policyRevision: sql`${mcpServers.policyRevision} + 1` }).where(eq(mcpServers.id, id));
  await audit(p.user.id, "mcp.identity_secret_rotated", id, { name: server.name });
  return { identitySecret };
}

export type McpImportPreview = {
  candidates: { name: string; url: string; transport: "http" | "sse"; headerNames: string[]; warnings: string[]; problem: string | null }[];
  rejected: { name: string; reason: string }[];
};

async function checkImport(text: string): Promise<McpImportPreview & { headers: Record<string, Record<string, string>> }> {
  const parsed = parseMcpConfig(z.string().max(MAX_IMPORT_CHARS).parse(text));
  const taken = new Set((await db.select({ name: mcpServers.name }).from(mcpServers)).map((r) => r.name.toLowerCase()));
  const candidates: McpImportPreview["candidates"] = [];
  const headers: Record<string, Record<string, string>> = {};
  for (const c of parsed.candidates) {
    const problem = taken.has(c.name.toLowerCase()) ? "A server with this name already exists" : await checkMcpUrl(c.url);
    taken.add(c.name.toLowerCase());
    candidates.push({ name: c.name, url: c.url, transport: c.transport, headerNames: Object.keys(c.headers), warnings: c.warnings, problem });
    headers[c.name] = c.headers;
  }
  return { candidates, rejected: parsed.rejected, headers };
}

/** Import step 1: what would be imported (header values stay on the server). */
export async function previewMcpImport(text: string): Promise<{ ok: true; preview: McpImportPreview } | { ok: false; error: string }> {
  await requireAdmin();
  try {
    const { candidates, rejected } = await checkImport(text);
    return { ok: true, preview: { candidates, rejected } };
  } catch (err) {
    return { ok: false, error: err instanceof z.ZodError ? "That's too much to import at once" : err instanceof Error ? err.message : String(err) };
  }
}

/** Import step 2: re-checks the pasted text and adds the importable servers as drafts, for everyone to see once enabled. */
export async function importMcpServers(text: string): Promise<{ created: number }> {
  const p = await requireAdmin();
  let checked: Awaited<ReturnType<typeof checkImport>>;
  try {
    checked = await checkImport(text);
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
  const rows = checked.candidates
    .filter((c) => !c.problem)
    .map((c) => {
      const h = checked.headers[c.name];
      return {
        id: newId(),
        name: c.name,
        url: c.url,
        transport: c.transport,
        status: "draft" as const,
        headersEnc: Object.keys(h).length ? encrypt(JSON.stringify(h), AAD.mcpHeaders) : null,
      };
    });
  if (rows.length) await db.insert(mcpServers).values(rows);
  await audit(p.user.id, "mcp.import", undefined, { created: rows.map((r) => ({ id: r.id, name: r.name, url: r.url })) });
  done();
  return { created: rows.length };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function saveBranding(value: BrandingSettings) {
  const p = await requireAdmin();
  const v = BrandingInput.parse(value);
  if (v.defaultAppId) await getAccessibleModel(p, v.defaultAppId);
  if (v.defaultBotId) await assertDefaultBot(p, v.defaultBotId, { shared: true });
  await setSetting("branding", v);
  await audit(p.user.id, "settings.branding", undefined, v);
  done();
}

/** A catalog pet needs `rights: "confirmed"`: the sign-in page is public, unlike the signed-in catalog. */
export async function saveLoginPet(choice: BotPetDefault, rights?: "confirmed") {
  const p = await requireAdmin();
  await storeLoginPet(p.user.id, botDefaultSchema.parse(choice), rights);
  revalidatePath("/login");
}

export async function saveLimits(value: LimitsSettings) {
  const p = await requireAdmin();
  const v = z.object({ uploadMaxMb: z.number().int().min(1).max(500), maxAttachmentsPerMessage: z.number().int().min(1).max(50) }).parse(value);
  await setSetting("limits", v);
  await audit(p.user.id, "settings.limits", undefined, v);
  done();
}

export async function saveRemoteHermesSettings(value: RemoteHermesSettings) {
  const p = await requireAdmin();
  const next = remoteHermesSettingsSchema.parse(value);
  await setSetting('remoteHermes', next);
  await audit(p.user.id, 'settings.remoteHermes', undefined, next);
  done();
}

export async function saveToolSettings(value: Omit<ToolSettings, "webSearch"> & { webSearch: { provider: ToolSettings["webSearch"]["provider"]; url?: string; apiKey?: string } }) {
  const p = await requireAdmin();
  const current = await getSetting("tools");
  const v = z
    .object({
      disabledTools: z.array(z.string()),
      enforcedApproval: z.array(z.string()),
      fetchAllowlist: z.array(z.string().trim().toLowerCase()).transform((l) => l.filter(Boolean)),
      webSearch: z.object({ provider: z.enum(["none", "searxng", "brave", "bing"]), url: z.string().optional(), apiKey: z.string().optional() }),
      nativeSearch: nativeSearchSettingsSchema.optional(),
      learningEnabled: z.boolean().optional(),
      learningRequireApproval: z.boolean().optional(),
      learningMaintenanceEnabled: z.boolean().optional(),
      learningConsolidationEnabled: z.boolean().optional(),
      maxStepsCap: z.number().int().min(1).max(100),
      botCreation: z.enum(["everyone", "groups", "admins"]),
      utilityAppId: z.string().optional(),
      embeddingAppId: z.string().optional(),
    })
    .parse(value);
  // Utility selections must always be eligible company models. Unchanged embedding selections remain
  // editable for compatibility, and runtime embedding resolution separately checks their eligibility.
  if (v.utilityAppId) {
    const [app] = await db.select().from(aiApps).where(eq(aiApps.id, v.utilityAppId));
    if (!app || !isEligibleUtilityApp(app)) throw new HttpError(400, "That connection can't be used for background work. Choose a company model.");
  }
  if (v.embeddingAppId && v.embeddingAppId !== current.embeddingAppId) {
    const [app] = await db.select().from(aiApps).where(eq(aiApps.id, v.embeddingAppId));
    if (!app || !isEligibleEmbeddingApp(app)) throw new HttpError(400, "That connection can't provide embeddings.");
  }
  const next: ToolSettings = {
    ...v,
    nativeSearch: v.nativeSearch ?? current.nativeSearch ?? NATIVE_SEARCH_DEFAULTS,
    learningEnabled: v.learningEnabled ?? current.learningEnabled ?? true,
    learningRequireApproval: v.learningRequireApproval ?? current.learningRequireApproval ?? false,
    learningMaintenanceEnabled: v.learningMaintenanceEnabled ?? current.learningMaintenanceEnabled ?? true,
    learningConsolidationEnabled: v.learningConsolidationEnabled ?? current.learningConsolidationEnabled ?? false,
    utilityAppId: v.utilityAppId || undefined,
    embeddingAppId: v.embeddingAppId || undefined,
    webSearch: {
      provider: v.webSearch.provider,
      url: v.webSearch.url || undefined,
      apiKeyEnc: v.webSearch.apiKey ? encrypt(v.webSearch.apiKey, AAD.webSearchKey) : current.webSearch.apiKeyEnc,
    },
  };
  await setSetting("tools", next);
  await audit(p.user.id, "settings.tools", undefined, { ...v, webSearch: { provider: v.webSearch.provider } });
  done();
}

// ---------------------------------------------------------------------------
// Sign in with ChatGPT
// ---------------------------------------------------------------------------

const lines = z
  .array(z.string().max(200))
  .max(1000)
  .transform((l) => [...new Set(l.map((x) => x.trim()).filter(Boolean))]);

const ChatGPTSettingsInput = z.object({
  enabled: z.boolean(),
  /** Required the first time it is turned on: the admin has read the "unofficial" notice. */
  acknowledge: z.boolean().optional(),
  access: z.enum(["everyone", "selected"]),
  allowedGroupIds: z.array(z.string().max(64)).max(500),
  allowedUpns: lines.transform((l) => l.map((u) => u.toLowerCase())),
  allowedWorkspaceIds: lines,
  allowPersonalPlans: z.boolean(),
  allowBackground: z.boolean(),
});
export type ChatGPTSettingsInput = z.input<typeof ChatGPTSettingsInput>;

export async function saveChatGPTSettings(raw: ChatGPTSettingsInput) {
  const p = await requireAdmin();
  const v = ChatGPTSettingsInput.parse(raw);
  const current = await getSetting("chatgpt");
  const firstEnable = v.enabled && !current.acknowledgedAt;
  if (firstEnable && !v.acknowledge) throw new HttpError(400, "Confirm that you've read the notice before turning this on.");
  const next: ChatGPTSettings = {
    enabled: v.enabled,
    acknowledgedBy: firstEnable ? p.user.upn : current.acknowledgedBy,
    acknowledgedAt: firstEnable ? new Date().toISOString() : current.acknowledgedAt,
    access: v.access,
    allowedGroupIds: v.allowedGroupIds,
    allowedUpns: v.allowedUpns,
    allowedWorkspaceIds: v.allowedWorkspaceIds,
    allowPersonalPlans: v.allowPersonalPlans,
    allowBackground: v.allowBackground,
  };
  await setSetting("chatgpt", next);
  const { acknowledge: _a, ...details } = v;
  void _a;
  await audit(p.user.id, "settings.chatgpt", undefined, { ...details, allowedUpns: v.allowedUpns.length });
  done();
}

// ---------------------------------------------------------------------------
// Workspaces (sandboxes)
// ---------------------------------------------------------------------------

const SandboxSettingsInput = z.object({
  enabled: z.boolean(),
  /** Required for each transition from disabled to enabled; checked again on the server. */
  acknowledgeEnable: z.boolean().optional(),
  access: z.enum(["everyone", "selected"]),
  allowedGroupIds: z.array(z.string()).max(1000),
  allowedUpns: lines,
  allowRunc: z.boolean(),
  /** Required the first time standard (runc) isolation is allowed. */
  acknowledgeRunc: z.boolean().optional(),
  commandTimeoutSec: z.number().int().min(5).max(3600),
  outputKb: z.number().int().min(4).max(1024),
  deleteAfterDays: z.number().int().min(0).max(3650),
});
export type SandboxSettingsInput = z.infer<typeof SandboxSettingsInput>;

export async function saveSandboxSettings(raw: SandboxSettingsInput) {
  const p = await requireAdmin();
  const v = SandboxSettingsInput.parse(raw);
  const current = await getSetting("sandbox");
  const firstRunc = v.allowRunc && !current.allowRunc;
  if (firstRunc && !v.acknowledgeRunc) throw new HttpError(400, "Confirm that you understand the weaker isolation before allowing it.");
  if (v.enabled && !current.enabled) {
    if (!v.acknowledgeEnable) throw new HttpError(400, "Confirm who will get workspace access before enabling it.");
    const { readWorkspaceSetup } = await import("@/lib/sandbox/setup-server");
    if (!(await readWorkspaceSetup(v.allowRunc)).ready) throw new HttpError(400, "Workspace prerequisites are not ready. Run the setup check and resolve the failed steps before enabling access.");
  }
  const next: SandboxSettings = {
    enabled: v.enabled,
    access: v.access,
    allowedGroupIds: v.allowedGroupIds,
    allowedUpns: v.allowedUpns.map((u) => u.toLowerCase()),
    allowRunc: v.allowRunc,
    runcAcknowledgedBy: v.allowRunc ? (firstRunc ? p.user.upn : current.runcAcknowledgedBy) : undefined,
    runcAcknowledgedAt: v.allowRunc ? (firstRunc ? new Date().toISOString() : current.runcAcknowledgedAt) : undefined,
    commandTimeoutSec: v.commandTimeoutSec,
    outputKb: v.outputKb,
    deleteAfterDays: v.deleteAfterDays,
  };
  await setSetting("sandbox", next);
  const { acknowledgeRunc: _a, acknowledgeEnable: _enable, ...details } = v;
  void _a;
  void _enable;
  await audit(p.user.id, "settings.sandbox", undefined, { ...details, allowedUpns: v.allowedUpns.length });
  done();
}

async function sandboxClientOrThrow() {
  const client = sandboxd();
  if (!client) throw new HttpError(400, "Workspaces aren't set up on this server (SANDBOXD_URL).");
  return client;
}

/** Stops a person's workspace (files are kept). */
export async function adminStopSandbox(userId: string) {
  const p = await requireAdmin();
  const row = await findSandbox(userId);
  if (!row) throw new HttpError(404, "No workspace");
  await (await sandboxClientOrThrow()).stop(row.ref);
  await audit(p.user.id, "workspace.admin_stop", userId);
  done();
}

/** Deletes a person's workspace and its files. The admin never sees the files, only that they existed. */
export async function adminDestroySandbox(userId: string) {
  const p = await requireAdmin();
  const row = await findSandbox(userId);
  if (!row) throw new HttpError(404, "No workspace");
  await (await sandboxClientOrThrow()).destroy(row.ref);
  await forgetSandbox(userId);
  await audit(p.user.id, "workspace.admin_destroy", userId);
  done();
}

/** Removes a sandbox no person owns any more (e.g. its account was deleted). */
export async function adminDestroyOrphan(ref: string) {
  const p = await requireAdmin();
  z.string().regex(/^[a-z0-9]{20}$/).parse(ref);
  const rows = await listSandboxRows();
  if (rows.some((r) => r.ref === ref)) throw new HttpError(400, "That workspace belongs to someone; remove it from their row.");
  await (await sandboxClientOrThrow()).destroy(ref);
  await audit(p.user.id, "workspace.orphan_destroy", undefined, { ref });
  done();
}

/** Deletes every ChatGPT connection and revokes the sign-ins at OpenAI. */
export async function disconnectAllChatGPT() {
  const p = await requireAdmin();
  const n = await deleteAllChatGPTConnections();
  await audit(p.user.id, "chatgpt.disconnect_all", undefined, { connections: n });
  done();
  return { disconnected: n };
}
