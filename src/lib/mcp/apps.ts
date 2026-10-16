import type { MCPClient } from '@ai-sdk/mcp';
import { and, eq, gt, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { aiApps, botTools, codexBotConfigs, groups, mcpAppActions, mcpAppInstances, mcpServers, toolGrants, type McpServer } from '@/db/schema';
import type { AgentCtx } from '@/lib/agent/types';
import { resolveApproval } from '@/lib/agent/approvals';
import { mcpTools, modelToolName } from '@/lib/agent/tools/mcp';
import type { Principal } from '@/lib/auth/groups';
import { getOwnedConversation, getUsableBot, HttpError, listAccessibleMcpServers } from '@/lib/authz';
import { activeServiceGrants } from '@/lib/bots/service';
import { decrypt, encrypt, sha256Hex } from '@/lib/crypto';
import { newId } from '@/lib/ids';
import { getSetting } from '@/lib/settings';
import { audit } from '@/lib/audit';
import { authorizeMcpInvocation } from './authorization';
import { appResource, appToolVisible, type AppActionReply, type AppView } from './apps-contract';
import { appComponentResult, appHtmlResource, appModelResult } from './apps-result';
import type { McpCallResult } from './hygiene';
import type { McpToolDef } from './kinds';
import { offeredTools } from './servers';
import { canonicalJson, toolHash } from './snapshot';

type Payload = Pick<AppView, 'html' | 'resourceHash' | 'input' | 'result' | 'compatibility' | 'sandboxUrl'>;
const aad = (id: string) => `mcp_app_instances.payload_enc|${id}`;
const resultAad = (id: string) => `mcp_app_actions.result_enc|${id}`;
const unavailable = () => new HttpError(403, 'This widget is expired or its permissions changed. Start a new chat turn.');

/** No cookies, credentials or app server code may be hosted on this origin. Fail closed when unconfigured. */
export function mcpAppSandboxUrl(): string | null {
  try {
    const host = new URL(process.env.AUTH_URL!);
    const sandbox = new URL(process.env.MCP_APPS_SANDBOX_URL!);
    if (host.origin === sandbox.origin || sandbox.pathname !== '/sandbox' || sandbox.username || sandbox.password || sandbox.search || sandbox.hash ||
        (sandbox.protocol !== 'https:' && !(sandbox.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(sandbox.hostname)))) return null;
    return sandbox.href;
  } catch { return null; }
}

/** Called only after the native tool executed. The HTML is pinned to this invocation; reload never re-executes it. */
export async function captureMcpApp(opts: { ctx: AgentCtx; binding: string; server: McpServer; def: McpToolDef; client: MCPClient;
  input: Record<string, unknown>; result: McpCallResult; authorize: () => Promise<unknown> }) {
  const { ctx, server, def } = opts;
  const model = appModelResult(opts.result, server.resultBudgetKb * 1024 - 80);
  const resource = appResource(def);
  const sandboxUrl = mcpAppSandboxUrl();
  if (!resource || !ctx.bot || !sandboxUrl || opts.result.isError) return model;
  try {
    await opts.authorize();
    const raw = await opts.client.readResource({ uri: resource.uri, options: { timeout: server.timeoutMs } });
    await opts.authorize();
    const { redactMcpValue } = await import('./client');
    const html = appHtmlResource(redactMcpValue(raw, server), resource.uri, resource.compatibility);
    const payload: Payload = { html, input: opts.input, compatibility: resource.compatibility, sandboxUrl,
      resourceHash: sha256Hex(html), result: appComponentResult(opts.result, server.resultBudgetKb * 1024) as AppView['result'] };
    if (Buffer.byteLength(JSON.stringify(payload)) > 1400000) throw new Error('Widget data exceeds the storage limit.');
    const id = newId();
    await db.insert(mcpAppInstances).values({ id, userId: ctx.principal.user.id, conversationId: ctx.conversationId,
      botId: ctx.bot.id, serverId: server.id, toolName: def.name, definitionHash: toolHash(def), binding: opts.binding,
      sessionVersion: ctx.principal.user.sessionVersion, runId: ctx.usage?.runId,
      payloadEnc: encrypt(JSON.stringify(payload), aad(id)), expiresAt: new Date(Date.now() + 86400000) });
    return { ...model, _mcpApp: id };
  } catch {
    // A bad/missing resource cannot erase a successful tool result or expose its private metadata.
    return appModelResult({ ...model, content: [...(model.content ?? []), { type: 'text', text: 'The interactive widget could not be loaded. The tool result is available as text.' }] }, server.resultBudgetKb * 1024);
  }
}

async function context(p: Principal, id: string) {
  const [instance] = await db.select().from(mcpAppInstances).where(and(eq(mcpAppInstances.id, id), eq(mcpAppInstances.userId, p.user.id), gt(mcpAppInstances.expiresAt, new Date())));
  if (!instance || instance.sessionVersion !== p.user.sessionVersion) throw unavailable();
  const conv = await getOwnedConversation(p, instance.conversationId);
  if (conv.botId !== instance.botId || conv.isGroup || conv.source !== 'chat' || conv.archived) throw unavailable();
  const bot = await getUsableBot(p, instance.botId);
  const [[app], [server], [codex], toolSettings] = await Promise.all([
    db.select().from(aiApps).where(eq(aiApps.id, bot.appId ?? '')),
    db.select().from(mcpServers).where(eq(mcpServers.id, instance.serverId)),
    db.select().from(codexBotConfigs).where(eq(codexBotConfigs.botId, bot.id)), getSetting('tools'),
  ]);
  if (!app?.enabled || !app.supportsTools || app.provider === 'hermes' || bot.hermesTeam || codex || !server?.toolsSnapshot) throw unavailable();
  const def = offeredTools(server).find(t => t.name === instance.toolName);
  if (!def || toolHash(def) !== instance.definitionHash || !appResource(def)) throw unavailable();
  const ctx: AgentCtx = { principal: p, bot, app, conversationId: conv.id, depth: 0, background: false, toolSettings,
    usage: { pending: [], runId: instance.runId ?? undefined } };
  const payload: Payload = JSON.parse(decrypt(instance.payloadEnc, aad(instance.id)));
  if (payload.sandboxUrl !== mcpAppSandboxUrl()) throw unavailable();
  await authorizeMcpInvocation(ctx, instance.binding, server, def, payload.input);
  return { instance, ctx, server, def, payload };
}

export async function loadMcpApp(p: Principal, id: string): Promise<AppView> {
  const sandboxUrl = mcpAppSandboxUrl();
  if (!sandboxUrl) throw new HttpError(409, 'The separate widget sandbox is not configured.');
  const { instance, payload, def } = await context(p, id);
  if (sha256Hex(payload.html) !== payload.resourceHash) throw unavailable();
  await audit(p.user.id, 'mcp.app.loaded', instance.serverId, { instance: id, resourceHash: payload.resourceHash });
  return { ...payload, title: def.title ?? def.name, sandboxUrl };
}

type AppContext = Awaited<ReturnType<typeof context>>;
async function toolsFor(c: AppContext, input: Record<string, unknown>, target: string) {
  const { ctx, server, instance, payload } = c;
  const [[configured], remembered, names] = await Promise.all([
    db.select().from(botTools).where(and(eq(botTools.botId, instance.botId), eq(botTools.toolKey, `mcp:${server.id}`))),
    db.select().from(toolGrants).where(and(eq(toolGrants.botId, instance.botId), eq(toolGrants.userId, ctx.principal.user.id))),
    ctx.principal.groupIds.length && server.identityHeader ? db.select({ name: groups.name }).from(groups).where(inArray(groups.id, ctx.principal.groupIds)) : [],
  ]);
  if (!configured) throw unavailable();
  const grants = ctx.bot!.executionMode === 'service' ? (await activeServiceGrants(instance.botId)).filter(g => g.serverId === server.id) : [];
  const targetDef = offeredTools(server).find(t => t.name === target);
  if (!targetDef || !appToolVisible(targetDef, 'app', payload.compatibility)) throw new HttpError(403, 'This tool is not available to this widget.');
  const u = ctx.principal.user;
  const caller = { subject: { kind: 'user' as const, id: u.id, upn: u.upn, email: u.email, name: u.name, groups: names.map(g => g.name).sort() },
    botId: instance.botId, conversationId: instance.conversationId,
    authorize: async () => {
      // Each initialize/transport/continuation is freshly authorized, before credentials are sent.
      await authorizeMcpInvocation(ctx, instance.binding, server, c.def, payload.input);
      await authorizeMcpInvocation(ctx, instance.binding, server, targetDef, input);
      return { subject: caller.subject, botId: caller.botId, conversationId: caller.conversationId };
    } };
  const toolset = mcpTools(server, { caller, config: configured.config ?? null, taken: new Set(),
    authority: { ctx, binding: instance.binding, grants }, apps: { audience: 'app', compatibility: payload.compatibility } });
  // Use the same cross-server aliases as the native toolset for name-based enforced/remembered approvals.
  // Legacy unsnapshotted servers can change aliases on discovery: fail closed until their review is captured.
  const configuredServers = await db.select().from(botTools).where(eq(botTools.botId, instance.botId));
  const configs = new Map(configuredServers.filter(t => t.toolKey.startsWith('mcp:')).map(t => [t.toolKey.slice(4), t.config]));
  const servers = (ctx.bot!.executionMode === 'service' ? await db.select().from(mcpServers) : await listAccessibleMcpServers(ctx.principal))
    .filter(s => configs.has(s.id) && !ctx.toolSettings.disabledTools.includes(`mcp:${s.id}`)).sort((a, b) => a.id.localeCompare(b.id));
  if (servers.some(s => !s.toolsSnapshot)) throw unavailable();
  const taken = new Set<string>(), aliases = new Map<string, string>();
  for (const audience of ['model', 'app'] as const) for (const s of servers) for (const d of offeredTools(s)) {
    const key = `${s.id}:${d.name}`, selected = configs.get(s.id)?.tools;
    if (aliases.has(key) || (selected && !selected.includes(d.name)) || !appToolVisible(d, audience)) continue;
    aliases.set(key, modelToolName(s, d.name, taken));
  }
  for (const entry of toolset.entries) entry.name = aliases.get(`${server.id}:${entry.mcp!.tool}`) ?? entry.name;
  return { toolset, decision: (entry: typeof toolset.entries[number]) => resolveApproval({
    toolName: entry.name, toolKey: entry.key, mode: configured.approval, sensitive: false,
    enforced: ctx.toolSettings.enforcedApproval, grants: new Set(remembered.map(g => g.toolName)), mcp: entry.mcp,
    grantable: appToolVisible(targetDef, 'model') ? entry.grantable : false,
  }), input };
}

function actionReply(row: typeof mcpAppActions.$inferSelect): AppActionReply {
  return { id: row.id, status: row.status, tool: row.toolName, input: row.input,
    ...(row.resultEnc ? { result: JSON.parse(decrypt(row.resultEnc, resultAad(row.id))) } : {}) };
}

/** One immutable id per UI request. Even an uncertain call cannot be dispatched again by retry/reload. */
export async function callMcpAppTool(p: Principal, instanceId: string, request: { id: string; name: string; arguments: Record<string, unknown> }) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(request.id) || typeof request.name !== 'string' || request.name.length > 256 ||
      !request.arguments || typeof request.arguments !== 'object' || Array.isArray(request.arguments) || Buffer.byteLength(JSON.stringify(request.arguments)) > 32000)
    throw new HttpError(400, 'Invalid widget tool request.');
  const c = await context(p, instanceId);
  const built = await toolsFor(c, request.arguments, request.name);
  try {
    const def = offeredTools(c.server).find(t => t.name === request.name);
    const entry = built.toolset.entries.find(e => e.mcp?.tool === request.name);
    if (!def || !entry || !appToolVisible(def, 'app', c.payload.compatibility)) throw new HttpError(403, 'This tool is not available to this widget.');
    entry.validateInput?.(request.arguments);
    await authorizeMcpInvocation(c.ctx, c.instance.binding, c.server, def, request.arguments);
    const row = await db.transaction(async tx => {
      await tx.select({ id: mcpAppInstances.id }).from(mcpAppInstances).where(eq(mcpAppInstances.id, instanceId)).for('update');
      if ((await tx.select({ id: mcpAppActions.id }).from(mcpAppActions).where(eq(mcpAppActions.id, request.id))).length) return undefined;
      if ((await tx.select({ id: mcpAppActions.id }).from(mcpAppActions).where(eq(mcpAppActions.instanceId, instanceId)).limit(100)).length >= 100)
        throw new HttpError(409, 'This widget has reached its 100 action limit. Start a new chat turn.');
      return (await tx.insert(mcpAppActions).values({ id: request.id, instanceId, toolName: def.name, definitionHash: toolHash(def),
        input: request.arguments, status: built.decision(entry) ? 'pending' : 'running' }).onConflictDoNothing().returning())[0];
    });
    if (!row) {
      const [previous] = await db.select().from(mcpAppActions).where(eq(mcpAppActions.id, request.id));
      if (!previous || previous.instanceId !== instanceId || previous.toolName !== request.name || canonicalJson(previous.input) !== canonicalJson(request.arguments))
        throw new HttpError(409, 'This widget request id has already been used.');
      return actionReply(previous);
    }
    await audit(p.user.id, 'mcp.app.requested', c.server.id, { instance: instanceId, action: row.id, tool: def.name, inputHash: sha256Hex(canonicalJson(row.input)), approval: row.status === 'pending' });
    if (row.status === 'pending') return actionReply(row);
    return await executeAction(c, row, entry);
  } finally { await built.toolset.close(); }
}

async function executeAction(c: AppContext, row: typeof mcpAppActions.$inferSelect, entry: Awaited<ReturnType<typeof toolsFor>>['toolset']['entries'][number]) {
  let result: unknown;
  let status: 'done' | 'error' = 'done';
  try {
    result = await entry.tool.execute!(row.input, { toolCallId: row.id, messages: [], context: undefined, abortSignal: AbortSignal.timeout(Math.min(c.server.timeoutMs + 5000, 120000)) });
    const target = offeredTools(c.server).find(t => t.name === row.toolName)!;
    await authorizeMcpInvocation(c.ctx, c.instance.binding, c.server, c.def, c.payload.input);
    await authorizeMcpInvocation(c.ctx, c.instance.binding, c.server, target, row.input);
    if (result && typeof result === 'object' && 'isError' in result && result.isError === true) status = 'error';
  } catch { status = 'error'; result = { isError: true, content: [{ type: 'text', text: 'The widget tool failed or its permissions changed. The request will not be retried automatically.' }] }; }
  const [saved] = await db.update(mcpAppActions).set({ status, resultEnc: encrypt(JSON.stringify(result), resultAad(row.id)) }).where(and(eq(mcpAppActions.id, row.id), eq(mcpAppActions.status, 'running'))).returning();
  await audit(c.ctx.principal.user.id, `mcp.app.${status}`, c.server.id, { instance: c.instance.id, action: row.id, tool: row.toolName });
  return actionReply(saved ?? row);
}

export async function decideMcpAppAction(p: Principal, instanceId: string, actionId: string, approve: boolean) {
  const c = await context(p, instanceId);
  const [row] = await db.select().from(mcpAppActions).where(and(eq(mcpAppActions.id, actionId), eq(mcpAppActions.instanceId, instanceId)));
  if (!row) throw new HttpError(404, 'Widget request not found.');
  const built = await toolsFor(c, row.input, row.toolName);
  try {
    const def = offeredTools(c.server).find(t => t.name === row.toolName);
    const entry = built.toolset.entries.find(e => e.mcp?.tool === row.toolName);
    if (!def || !entry || toolHash(def) !== row.definitionHash) throw unavailable();
    entry.validateInput?.(row.input);
    await authorizeMcpInvocation(c.ctx, c.instance.binding, c.server, def, row.input);
    const [claimed] = await db.update(mcpAppActions).set({ status: approve ? 'running' : 'denied' }).where(and(eq(mcpAppActions.id, row.id), eq(mcpAppActions.status, 'pending'))).returning();
    if (!claimed) {
      const [current] = await db.select().from(mcpAppActions).where(eq(mcpAppActions.id, row.id));
      return actionReply(current ?? row); // already decided: never dispatch twice
    }
    await audit(p.user.id, approve ? 'mcp.app.approved' : 'mcp.app.denied', c.server.id, { instance: instanceId, action: row.id, tool: row.toolName });
    return approve ? await executeAction(c, claimed, entry) : actionReply(claimed);
  } finally { await built.toolset.close(); }
}

export async function listMcpAppActions(p: Principal, id: string) {
  await context(p, id);
  return (await db.select().from(mcpAppActions).where(eq(mcpAppActions.instanceId, id)).orderBy(mcpAppActions.createdAt).limit(100)).map(actionReply);
}
