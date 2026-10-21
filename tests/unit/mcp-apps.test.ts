import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { convertToModelMessages } from 'ai';
import type { Principal } from '@/lib/auth/groups';
import type { AgentCtx } from '@/lib/agent/types';
import type { McpServer } from '@/db/schema';
import type { McpCallResult } from '@/lib/mcp/hygiene';
import type { PortalUIMessage } from '@/lib/chat/store';
import { ticketDraftMarkup, ticketDraftResult, ticketDraftTool } from '../fixtures/mcp-apps/ticket-draft.mjs';

const fixture = vi.hoisted(() => ({ client: null as PGlite | null, human: null as Principal | null, connect: vi.fn(), calls: [] as string[],
  resource: vi.fn(), duringCall: null as (() => Promise<void>) | null }));
vi.mock('server-only', () => ({}));
vi.mock('@/db', async () => {
  const { PGlite } = await import('@electric-sql/pglite'), { drizzle } = await import('drizzle-orm/pglite'), schema = await import('@/db/schema');
  fixture.client = new PGlite(); return { db: drizzle(fixture.client, { schema }), schema };
});
vi.mock('@/lib/mcp/client', async original => ({ ...await original<typeof import('@/lib/mcp/client')>(), connectMcp: fixture.connect }));
vi.mock('@/lib/session', async () => {
  const { HttpError } = await import('@/lib/authz');
  return { requirePrincipal: async () => { if (!fixture.human) throw new HttpError(401, 'Unauthorized'); return fixture.human; },
    errorResponse: (e: unknown) => Response.json({ error: e instanceof Error ? e.message : 'Internal error' }, { status: e instanceof HttpError ? e.status : 500 }) };
});
import { db, schema } from '@/db';
import { loadPrincipal } from '@/lib/auth/groups';
import { mcpAuthorityBinding, authorizeMcpInvocation } from '@/lib/mcp/authorization';
import { callMcpAppTool, captureMcpApp, decideMcpAppAction, listMcpAppActions, loadMcpApp, mcpAppSandboxUrl } from '@/lib/mcp/apps';
import { appInstanceId, appResource, appToolVisible } from '@/lib/mcp/apps-contract';
import { appComponentResult, appHtmlResource, appModelResult, MAX_APP_META_BYTES } from '@/lib/mcp/apps-result';
import { capResult, mcpResultToModelOutput } from '@/lib/mcp/hygiene';
import { diffTools, snapshotHash, toToolDef, toolHash } from '@/lib/mcp/snapshot';
import { activeServiceGrants, serviceConfigHash } from '@/lib/bots/service';
import { sealIdentitySecret } from '@/lib/mcp/identity';
import { scrubForeignOpenAIMetadata } from '@/lib/agent/replay';
import { mcpTools } from '@/lib/agent/tools/mcp';
import { getSetting, setSetting } from '@/lib/settings';
import { acceptMcpDrift, offeredTools, refreshMcpServer } from '@/lib/mcp/servers';
import { GET, POST } from '@/app/api/mcp-apps/[id]/route';

const privateMarker = 'SYNTHETIC_COMPONENT_ONLY_8192';
const result = { content: [{ type: 'text', text: 'Two synthetic rows.' }], structuredContent: { rows: [{ label: 'Alpha' }, { label: 'Beta' }] }, _meta: { privateMarker } };
const html = '<!doctype html><form><input name="filter"><button>Apply</button></form><table><tr><td>Synthetic</td></tr></table>';
const tool = (name: string, meta: object = {}, overrides: object = {}) => toToolDef({ name, inputSchema: { type: 'object', properties: { filter: { type: 'string' } } },
  annotations: { readOnlyHint: true }, _meta: meta, ...overrides })!;
const defs = [tool('view', { ui: { resourceUri: 'ui://synthetic/view' } }), tool('refresh'),
  tool('save', { ui: { visibility: ['app'] } }, { annotations: { destructiveHint: true } }),
  tool('model_only', { ui: { visibility: ['model'] } })];
let p: Principal, other: Principal, ctx: AgentCtx, server: McpServer, binding: string;
const loadServer = async () => (await db.select().from(schema.mcpServers).where(eq(schema.mcpServers.id, 'synthetic')))[0];
const request = (id = randomUUID(), name = 'refresh', args: Record<string, unknown> = {}) => ({ id, name, arguments: args });
async function capture(def = defs[0], suppliedResult: McpCallResult = result) {
  const client = { readResource: fixture.resource };
  const output = await captureMcpApp({ ctx, binding, server, def, client: client as never, input: {}, result: suppliedResult,
    authorize: () => authorizeMcpInvocation(ctx, binding, server, def, {}) });
  return { output, id: appInstanceId(output)! };
}
beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync('src/db/migrations').filter(x => x.endsWith('.sql')).sort())
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, 'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g, 'real[]'));
}, 45000);
beforeEach(async () => {
  vi.stubEnv('AUTH_URL', 'https://host.test.invalid'); vi.stubEnv('MCP_APPS_SANDBOX_URL', 'https://sandbox.test.invalid/sandbox');
  vi.stubEnv('ENCRYPTION_KEY', 'synthetic-apps-test-only'); vi.stubEnv('ENCRYPTION_KEYS', ''); vi.stubEnv('ENCRYPTION_PRIMARY_KID', '');
  await fixture.client!.exec('TRUNCATE users, ai_apps, mcp_servers, settings CASCADE');
  fixture.calls = []; fixture.connect.mockReset(); fixture.resource.mockReset(); fixture.duringCall = null;
  await db.insert(schema.users).values([{ id: 'owner', upn: 'owner@example.invalid', name: 'Fixture owner', isAdmin: true, authSource: 'local', identityRealm: 'local' }, { id: 'other', upn: 'other@example.invalid', name: 'Fixture other', isAdmin: true, authSource: 'local', identityRealm: 'local' }]);
  p = (await loadPrincipal('owner'))!; other = (await loadPrincipal('other'))!; fixture.human = p;
  await db.insert(schema.aiApps).values({ id: 'model', name: 'Synthetic model', provider: 'openai-compatible', baseUrl: 'https://provider.example.invalid/v1', model: 'fixture', supportsTools: true });
  await db.insert(schema.bots).values({ id: 'bot', ownerId: 'owner', name: 'Fixture bot', appId: 'model', visibility: 'org' });
  await db.insert(schema.conversations).values({ id: 'chat', userId: 'owner', botId: 'bot' });
  await db.insert(schema.mcpServers).values({ id: 'synthetic', name: 'Fixture', url: 'https://mcp.example.invalid/mcp', status: 'enabled', trust: 'trusted',
    toolsSnapshot: defs, toolsHash: snapshotHash(defs), resultBudgetKb: 64, toolPolicy: { save: { requireApproval: true } } });
  await db.insert(schema.botTools).values({ botId: 'bot', toolKey: 'mcp:synthetic', approval: 'smart' });
  server = await loadServer();
  ctx = { principal: p, conversationId: 'chat', bot: (await db.select().from(schema.bots))[0], app: (await db.select().from(schema.aiApps))[0],
    depth: 0, background: false, toolSettings: await getSetting('tools') };
  binding = await mcpAuthorityBinding(ctx, server, null, []);
  fixture.resource.mockResolvedValue({ contents: [{ uri: 'ui://synthetic/view', mimeType: 'text/html;profile=mcp-app', text: html }] });
  fixture.connect.mockImplementation(async (_s, caller) => {
    await caller.authorize?.();
    return { toolsFromDefinitions: () => ({}), close: async () => {}, readResource: fixture.resource,
      callTool: async ({ name }: { name: string }) => {
        await caller.authorize?.(); fixture.calls.push(name); await fixture.duringCall?.(); return result;
      } };
  });
});
afterAll(async () => { await fixture.client!.close(); vi.unstubAllEnvs(); });

describe('Reviewed MCP App descriptors and bounded results', () => {
  it('allows only validated resource/visibility metadata, rejects malformed fields, and detects routing/permission drift', () => {
    const d = tool('x', { ui: { resourceUri: 'ui://synthetic/view', visibility: ['app'], arbitrary: 'drop' }, arbitrary: privateMarker, 'openai/widgetAccessible': true });
    expect(d._meta).toEqual({ ui: { resourceUri: 'ui://synthetic/view', visibility: ['app'] }, 'openai/widgetAccessible': true });
    for (const meta of [{ ui: { resourceUri: 'https://example.invalid' } }, { ui: { visibility: [] } }, { ui: { visibility: ['secret'] } }, { 'openai/widgetAccessible': 'yes' }])
      expect(toToolDef({ name: 'invalid', _meta: meta })).toBeNull();
    for (const meta of [{ ui: { resourceUri: 'ui://changed/view' } }, { ui: { visibility: ['model'] } }, { 'openai/widgetAccessible': false }])
      expect(diffTools([d], [tool('x', meta)]).changed).toEqual(['x']);
    expect(appResource(tool('old', { 'ui/resourceUri': 'ui://old' }))).toEqual({ uri: 'ui://old', compatibility: false });
    expect(appResource(tool('openai', { 'openai/outputTemplate': 'ui://old' }))).toEqual({ uri: 'ui://old', compatibility: true });
    expect(appToolVisible(defs[2], 'model')).toBe(false); expect(appToolVisible(defs[3], 'app')).toBe(false);
  });
  it('retains narration and structured data within the model budget, with separately capped component metadata', () => {
    const model = appModelResult(result, 1024);
    expect(model).toEqual({ content: result.content, structuredContent: result.structuredContent });
    expect(appComponentResult(result, 1024)).toEqual({ ...model, _meta: result._meta });
    expect(appComponentResult({ ...result, _meta: { data: 'x'.repeat(MAX_APP_META_BYTES) } }, 1024)).toEqual(model);
    expect(capResult(result, 1024)).toEqual({ content: result.content }); // other harness behavior unchanged
    for (const budget of [128, 1024, 65536]) expect(Buffer.byteLength(JSON.stringify(appModelResult({ ...result, structuredContent: { huge: 'x'.repeat(100000) } }, budget)))).toBeLessThanOrEqual(budget);
  });
  it('rejects resource substitution, multiple documents, bad MIME/base64 and oversized HTML', () => {
    const raw = (over: object) => ({ contents: [{ uri: 'ui://synthetic/view', mimeType: 'text/html;profile=mcp-app', text: html, ...over }] });
    expect(appHtmlResource(raw({}), 'ui://synthetic/view', false)).toBe(html);
    expect(appHtmlResource(raw({ text: undefined, blob: Buffer.from(html).toString('base64') }), 'ui://synthetic/view', false)).toBe(html);
    for (const r of [raw({ uri: 'ui://other' }), raw({ mimeType: 'text/html' }), raw({ text: 'x'.repeat(1048577) }), { contents: [] }, raw({ text: undefined, blob: '%%%%' })])
      expect(() => appHtmlResource(r, 'ui://synthetic/view', false)).toThrow();
    expect(appHtmlResource(raw({ mimeType: 'text/html+skybridge' }), 'ui://synthetic/view', true)).toBe(html);
  });
});

describe('Native resource capture, persistence and private metadata isolation', () => {
  it('captures the synthetic Ticket Tracker draft and retains safe diagnostics when its sandbox is disabled', async () => {
    const def = toToolDef(ticketDraftTool)!;
    await db.update(schema.mcpServers).set({ toolsSnapshot: [def], toolsHash: snapshotHash([def]) });
    server = await loadServer(); binding = await mcpAuthorityBinding(ctx, server, null, []);
    fixture.resource.mockResolvedValue({ contents: [{ uri: 'ui://synthetic-ticket-tracker/draft', mimeType: 'text/html;profile=mcp-app', text: ticketDraftMarkup }] });
    const captured = await capture(def, ticketDraftResult);
    expect(captured.id).toBeTruthy(); expect((await loadMcpApp(p, captured.id)).html).toContain('Synthetic Ticket Tracker draft');
    expect(JSON.stringify(captured.output)).not.toContain('SYNTHETIC_TICKET_COMPONENT_ONLY');
    vi.stubEnv('MCP_APPS_SANDBOX_URL', '');
    const disabled = await capture(def, ticketDraftResult);
    expect(disabled.id).toBeNull(); expect(JSON.stringify(disabled.output)).toContain('MCP_APPS_SANDBOX_URL');
    expect(fixture.resource).toHaveBeenCalledTimes(1); expect(fixture.calls).toEqual([]);
  });
  it('captures a widget through the real native MCP tool execution wrapper', async () => {
    const toolset = mcpTools(server, { caller: { subject: { kind: 'user', id: p.user.id, upn: p.user.upn, email: p.user.email, name: p.user.name, groups: [] } },
      config: null, taken: new Set(), authority: { ctx, binding, grants: [] }, apps: { audience: 'model' } });
    try {
      const entry = toolset.entries.find(e => e.mcp?.tool === 'view')!;
      const output = await entry.tool.execute!({}, { toolCallId: 'native-source', messages: [], context: undefined });
      const id = appInstanceId(output); expect(id).toBeTruthy();
      expect((await loadMcpApp(p, id!)).result._meta).toEqual(result._meta);
      expect(JSON.stringify(mcpResultToModelOutput({ output }))).not.toContain(privateMarker);
      expect(fixture.connect.mock.calls[0][1].apps).toBe(true);
    } finally { await toolset.close(); }
  });
  it('loads only the reviewed URI, stores component data encrypted, and never sends it to model replay even without the tool', async () => {
    const { output, id } = await capture(defs[0], { ...result, _meta: { privateMarker, ui: { resourceUri: 'ui://attacker' } } });
    expect(id).toBeTruthy(); expect(fixture.resource).toHaveBeenCalledWith({ uri: 'ui://synthetic/view', options: { timeout: server.timeoutMs } });
    expect(JSON.stringify(output)).not.toContain(privateMarker); expect(JSON.stringify(output)).not.toContain(html);
    expect(JSON.stringify(await db.select().from(schema.mcpAppInstances))).not.toContain(privateMarker);
    const view = await loadMcpApp(p, id); expect(view.result._meta).toMatchObject({ privateMarker }); expect(view.result.structuredContent).toEqual(result.structuredContent);
    const model = mcpResultToModelOutput({ output }); expect(JSON.stringify(model)).toContain('Alpha'); expect(JSON.stringify(model)).toContain('Two synthetic rows');
    expect(JSON.stringify(model)).not.toContain(privateMarker); expect(JSON.stringify(model)).not.toContain(id);
    const history = [{ id: 'reply', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'retired', toolCallId: 'c', state: 'output-available', input: {}, output }] }] as PortalUIMessage[];
    const replay = scrubForeignOpenAIMetadata(history, { appId: 'new-model', providerKind: 'openai-compatible', model: 'fixture' });
    expect(JSON.stringify(await convertToModelMessages(replay))).not.toContain('_mcpApp');
    expect(JSON.stringify(await convertToModelMessages(replay))).not.toContain(privateMarker);
    expect(JSON.stringify(await db.select().from(schema.auditLog))).not.toContain(privateMarker);
  });
  it('reload restores pinned HTML without another resources/read or tool call, and rejects another owner', async () => {
    const { id } = await capture();
    await loadMcpApp(p, id); fixture.resource.mockRejectedValue(new Error('resource changed'));
    expect((await loadMcpApp(p, id)).html).toBe(html); expect(fixture.resource).toHaveBeenCalledTimes(1); expect(fixture.calls).toEqual([]);
    await expect(loadMcpApp(other, id)).rejects.toMatchObject({ status: 403 });
  });
  it('keeps successful text when resources fail and fails closed without a separate sandbox', async () => {
    fixture.resource.mockRejectedValue(new Error('synthetic missing resource PRIVATE_RESOURCE_SECRET'));
    const { output, id } = await capture(); expect(id).toBeNull(); expect(JSON.stringify(output)).toContain('could not be loaded'); expect(JSON.stringify(output)).not.toContain(privateMarker);
    expect(JSON.stringify(output)).not.toContain('PRIVATE_RESOURCE_SECRET');
    vi.stubEnv('MCP_APPS_SANDBOX_URL', 'https://host.test.invalid/sandbox'); expect(mcpAppSandboxUrl()).toBeNull();
    expect((await capture()).id).toBeNull();
    for (const bad of ['https://u:p@sandbox.test.invalid/sandbox', 'http://public.example.invalid/sandbox', 'https://sandbox.test.invalid/sandbox?x=1']) {
      vi.stubEnv('MCP_APPS_SANDBOX_URL', bad); expect(mcpAppSandboxUrl()).toBeNull();
    }
  });
  it('requires the exact /sandbox endpoint served by the dedicated proxy', () => {
    for (const path of ['/', '/widgets', '/sandbox/', '/prefix/sandbox', '/%73andbox', '/sandbox?', '/sandbox#']) {
      vi.stubEnv('MCP_APPS_SANDBOX_URL', `https://sandbox.test.invalid${path}`);
      expect(mcpAppSandboxUrl()).toBeNull();
    }
    for (const url of ['https://sandbox.test.invalid/sandbox', 'http://127.0.0.1:3102/sandbox']) {
      vi.stubEnv('MCP_APPS_SANDBOX_URL', url);
      expect(mcpAppSandboxUrl()).toBe(url);
    }
  });
  it.each(['', 'https://private-user:PRIVATE_SECRET@sandbox.test.invalid/sandbox?PRIVATE_QUERY'])('explains missing/invalid sandbox configuration without disclosing values (%s)', async url => {
    vi.stubEnv('MCP_APPS_SANDBOX_URL', url);
    const { output, id } = await capture();
    expect(id).toBeNull(); expect(fixture.resource).not.toHaveBeenCalled();
    expect(JSON.stringify(output)).toContain('MCP_APPS_SANDBOX_URL');
    expect(JSON.stringify(output)).toContain('both web and worker');
    expect(JSON.stringify(output)).toContain('Two synthetic rows');
    for (const secret of ['private-user', 'PRIVATE_SECRET', 'PRIVATE_QUERY', privateMarker]) expect(JSON.stringify(output)).not.toContain(secret);
    expect(await db.select().from(schema.mcpAppInstances)).toEqual([]);
  });
  it('retains a configuration diagnostic under the result budget and leaves ordinary/failed tools alone', async () => {
    vi.stubEnv('MCP_APPS_SANDBOX_URL', '');
    const { output } = await capture(defs[0], { ...result, content: [{ type: 'text', text: 'x'.repeat(100000) }] });
    expect(JSON.stringify(output)).toContain('MCP_APPS_SANDBOX_URL');
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(server.resultBudgetKb * 1024);
    expect((await capture(defs[1])).output).toEqual(appModelResult(result, server.resultBudgetKb * 1024 - 80));
    expect((await capture(defs[0], { ...result, isError: true })).output).toEqual(appModelResult({ ...result, isError: true }, server.resultBudgetKb * 1024 - 80));
  });
  it('rejects invalid host configuration without leaking it in fallback or load errors', async () => {
    const { id } = await capture();
    vi.stubEnv('AUTH_URL', 'https://PRIVATE_USER:PRIVATE_SECRET@host.test.invalid');
    expect(mcpAppSandboxUrl()).toBeNull();
    expect(JSON.stringify((await capture()).output)).toContain('AUTH_URL');
    await expect(loadMcpApp(p, id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('AUTH_URL') });
    expect(JSON.stringify((await capture()).output)).not.toContain('PRIVATE_SECRET');
  });
  it.each([
    { ui: { resourceUri: 'ui://synthetic/view' } },
    { 'ui/resourceUri': 'ui://synthetic/view' },
    { 'openai/outputTemplate': 'ui://synthetic/view' },
  ])('requires explicit drift review when refreshing metadata discarded by an older snapshot (%j)', async meta => {
    const old = tool('draft_ticket');
    const advertised = tool('draft_ticket', meta);
    await db.update(schema.mcpServers).set({ toolsSnapshot: [old], toolsHash: snapshotHash([old]) });
    fixture.connect.mockResolvedValueOnce({ listTools: async () => ({ tools: [advertised] }), close: async () => {} });
    const refreshed = await refreshMcpServer(server.id, p.user.id);
    expect(refreshed).toMatchObject({ ok: true, result: 'drift', drift: { changed: ['draft_ticket'] } });
    expect(fixture.connect.mock.calls[0][1].apps).toBe(true);
    const pending = await loadServer();
    expect(appResource(pending.toolsSnapshot![0])).toBeNull(); expect(offeredTools(pending)).toEqual([]);
    expect(await acceptMcpDrift(server.id, pending.toolsDrift!.hash)).toEqual({ ok: true });
    expect(appResource(offeredTools(await loadServer())[0])).toMatchObject({ uri: 'ui://synthetic/view' });
    expect(fixture.resource).not.toHaveBeenCalled(); expect(fixture.calls).toEqual([]);
  });
  it.each(['server', 'bot', 'session', 'descriptor', 'expiry', 'codex', 'hermes', 'sandbox'])('revokes loading and actions after %s changes', async change => {
    const { id } = await capture();
    if (change === 'server') await db.update(schema.mcpServers).set({ status: 'disabled' });
    if (change === 'bot') await db.update(schema.bots).set({ enabled: false });
    if (change === 'session') await db.update(schema.users).set({ sessionVersion: p.user.sessionVersion + 1 }).where(eq(schema.users.id, p.user.id));
    if (change === 'descriptor') await db.update(schema.mcpServers).set({ toolsDrift: { detectedAt: '', hash: '', tools: [], added: [], removed: [], changed: ['view'] } });
    if (change === 'expiry') await db.update(schema.mcpAppInstances).set({ expiresAt: new Date(0) });
    if (change === 'codex') await db.insert(schema.codexBotConfigs).values({ botId: 'bot', policy: {} as never });
    if (change === 'hermes') await db.update(schema.aiApps).set({ provider: 'hermes' });
    if (change === 'sandbox') vi.stubEnv('MCP_APPS_SANDBOX_URL', 'https://changed-sandbox.test.invalid/sandbox');
    await expect(loadMcpApp(p, id)).rejects.toBeInstanceOf(Error);
    await expect(callMcpAppTool(p, id, request())).rejects.toBeInstanceOf(Error); expect(fixture.calls).toEqual([]);
  });
});

describe('Widget actions use the native authorization and approval policy', () => {
  it('dispatches trusted read-only actions once, reauthorizes transport, and returns metadata only to the component', async () => {
    const { id } = await capture(), r = request();
    const first = await callMcpAppTool(p, id, r); expect(first.status).toBe('done'); expect(first.result?._meta).toEqual(result._meta);
    expect(await callMcpAppTool(p, id, r)).toEqual(first); expect(fixture.calls).toEqual(['refresh']);
    expect(fixture.connect.mock.calls[0][1].subject.id).toBe(p.user.id); expect(fixture.connect.mock.calls[0][1].authorize).toBeTypeOf('function');
    await expect(callMcpAppTool(p, id, { ...r, arguments: { filter: 'different' } })).rejects.toMatchObject({ status: 409 });
  });
  it('persists approvals through reload and atomically dispatches immutable approved input only once', async () => {
    const { id } = await capture(), r = request(randomUUID(), 'save', { filter: 'Beta' });
    const action = await callMcpAppTool(p, id, r); expect(action.status).toBe('pending'); expect(fixture.calls).toEqual([]);
    expect((await listMcpAppActions(p, id))[0]).toMatchObject({ status: 'pending', input: { filter: 'Beta' } });
    await loadMcpApp(p, id);
    await Promise.all([decideMcpAppAction(p, id, r.id, true), decideMcpAppAction(p, id, r.id, true)]);
    expect(fixture.calls).toEqual(['save']); expect((await listMcpAppActions(p, id))[0].status).toBe('done');
    await decideMcpAppAction(p, id, r.id, true); expect(fixture.calls).toEqual(['save']);
  });
  it('denial never dispatches and a request id cannot cross instances', async () => {
    const { id } = await capture(), r = request(randomUUID(), 'save'); await callMcpAppTool(p, id, r);
    expect((await decideMcpAppAction(p, id, r.id, false)).status).toBe('denied'); await decideMcpAppAction(p, id, r.id, true); expect(fixture.calls).toEqual([]);
    const second = await capture(); await expect(callMcpAppTool(p, second.id, r)).rejects.toMatchObject({ status: 409 });
  });
  it('blocks schema violations, model-only tools, revoked target tools, and approval after policy changes', async () => {
    const { id } = await capture();
    await expect(callMcpAppTool(p, id, request(randomUUID(), 'refresh', { filter: 1 }))).rejects.toThrow();
    await expect(callMcpAppTool(p, id, request(randomUUID(), 'model_only'))).rejects.toMatchObject({ status: 403 });
    const pending = await callMcpAppTool(p, id, request(randomUUID(), 'save'));
    await db.update(schema.mcpServers).set({ toolPolicy: { save: { enabled: false } } });
    await expect(decideMcpAppAction(p, id, pending.id, true)).rejects.toBeInstanceOf(Error); expect(fixture.calls).toEqual([]);
  });
  it('org enforcement beats remembered grants and untrusted Smart actions ask', async () => {
    await setSetting('tools', { ...ctx.toolSettings, enforcedApproval: ['mcp:synthetic'] }); ctx.toolSettings = await getSetting('tools');
    await db.insert(schema.toolGrants).values({ userId: p.user.id, botId: 'bot', toolName: 'fixture__refresh' });
    binding = await mcpAuthorityBinding(ctx, server, null, []);
    let captured = await capture(); expect((await callMcpAppTool(p, captured.id, request())).status).toBe('pending');
    await setSetting('tools', { ...ctx.toolSettings, enforcedApproval: [] }); ctx.toolSettings = await getSetting('tools');
    await db.delete(schema.toolGrants); await db.update(schema.mcpServers).set({ trust: 'untrusted' }); server = await loadServer();
    binding = await mcpAuthorityBinding(ctx, server, null, []); captured = await capture();
    expect((await callMcpAppTool(p, captured.id, request())).status).toBe('pending'); expect(fixture.calls).toEqual([]);
  });
  it('does not release private results after in-flight revocation or retry uncertain executions', async () => {
    const { id } = await capture(), r = request(); fixture.duringCall = async () => { await db.update(schema.mcpServers).set({ status: 'disabled' }); };
    const action = await callMcpAppTool(p, id, r); expect(action.status).toBe('error'); expect(JSON.stringify(action)).not.toContain(privateMarker); expect(fixture.calls).toEqual(['refresh']);
    await expect(callMcpAppTool(p, id, r)).rejects.toBeInstanceOf(Error); expect(fixture.calls).toEqual(['refresh']);
  });
  it('hides app-only tools from the model and bounds legacy tool access to explicit widgetAccessible', async () => {
    const options = { caller: { subject: { kind: 'system' as const } }, config: null, taken: new Set<string>() };
    const model = mcpTools(server, { ...options, apps: { audience: 'model' } });
    expect(model.entries.map(e => e.mcp?.tool)).not.toContain('save'); await model.close();
    const compat = mcpTools(server, { ...options, apps: { audience: 'app', compatibility: true } }); expect(compat.entries).toHaveLength(0); await compat.close();
  });
  it('enforces OpenAI widgetAccessible on the production action path', async () => {
    const legacyView = tool('view', { 'openai/outputTemplate': 'ui://synthetic/view' });
    const accessible = tool('refresh', { 'openai/widgetAccessible': true });
    await db.update(schema.mcpServers).set({ toolsSnapshot: [legacyView, accessible, defs[2]] }); server = await loadServer();
    binding = await mcpAuthorityBinding(ctx, server, null, []);
    fixture.resource.mockResolvedValue({ contents: [{ uri: 'ui://synthetic/view', mimeType: 'text/html+skybridge', text: html }] });
    const { id } = await capture(legacyView); expect((await loadMcpApp(p, id)).compatibility).toBe(true);
    expect((await callMcpAppTool(p, id, request())).status).toBe('done');
    await expect(callMcpAppTool(p, id, request(randomUUID(), 'save'))).rejects.toMatchObject({ status: 403 }); expect(fixture.calls).toEqual(['refresh']);
  });
  it('bounds requests per instance and still permits exact idempotent reads at the limit', async () => {
    const { id } = await capture();
    const rows = Array.from({ length: 100 }, () => ({ id: randomUUID(), instanceId: id, toolName: 'save', definitionHash: toolHash(defs[2]), input: {}, status: 'pending' as const }));
    await db.insert(schema.mcpAppActions).values(rows);
    await expect(callMcpAppTool(p, id, request(randomUUID(), 'save'))).rejects.toMatchObject({ status: 409 });
    expect((await callMcpAppTool(p, id, request(rows[0].id, 'save'))).status).toBe('pending'); expect(fixture.calls).toEqual([]);
  });
  it('uses native collision aliases for organization-enforced approvals', async () => {
    await db.insert(schema.mcpServers).values({ id: 'a-other', name: 'Fixture', url: 'https://other.example.invalid/mcp', status: 'enabled', trust: 'trusted', toolsSnapshot: [defs[1]], toolsHash: snapshotHash([defs[1]]) });
    await db.insert(schema.botTools).values({ botId: 'bot', toolKey: 'mcp:a-other', approval: 'smart' });
    await setSetting('tools', { ...ctx.toolSettings, enforcedApproval: ['fixture__refresh_2'] }); ctx.toolSettings = await getSetting('tools');
    binding = await mcpAuthorityBinding(ctx, server, null, []);
    const { id } = await capture(); expect((await callMcpAppTool(p, id, request())).status).toBe('pending'); expect(fixture.calls).toEqual([]);
  });
  it('retains service publication, exact scope, grant identity and revocation for widget writes', async () => {
    const config = { tools: ['view', 'save'] };
    await db.update(schema.botTools).set({ config });
    await db.update(schema.mcpServers).set({ identityHeader: 'X-Portal-Identity', identitySecretEnc: sealIdentitySecret(server.id, 'synthetic-service-secret') }); server = await loadServer();
    await db.update(schema.bots).set({ executionMode: 'service' });
    for (const def of [defs[0], defs[2]]) await db.insert(schema.botMcpGrants).values({ id: `grant-${def.name}`, botId: 'bot', botRevision: 1,
      serverId: server.id, serverRevision: server.policyRevision, toolName: def.name, toolHash: toolHash(def), effect: def.name === 'save' ? 'write' : 'read',
      requireApproval: def.name === 'save', constraints: def.name === 'save' ? [{ path: 'filter', source: 'constant', value: 'Beta' }] : [] });
    let bot = (await db.select().from(schema.bots))[0];
    await db.update(schema.bots).set({ publishedRevision: bot.revision, publishedConfigHash: await serviceConfigHash(bot) }); bot = (await db.select().from(schema.bots))[0];
    ctx = { ...ctx, bot }; binding = await mcpAuthorityBinding(ctx, server, config, await activeServiceGrants(bot.id));
    const { id } = await capture(); expect(id).toBeTruthy();
    await expect(callMcpAppTool(p, id, request(randomUUID(), 'save', { filter: 'Alpha' }))).rejects.toThrow(); expect(fixture.calls).toEqual([]);
    const action = await callMcpAppTool(p, id, request(randomUUID(), 'save', { filter: 'Beta' })); expect(action.status).toBe('pending');
    expect((await decideMcpAppAction(p, id, action.id, true)).status).toBe('done');
    const caller = fixture.connect.mock.calls[0][1];
    expect(caller.service).toMatchObject({ id: 'bot:bot', grant: 'grant-save', tool: 'save', call: action.id });
    expect((await caller.authorize()).service).toEqual(caller.service);
    await db.update(schema.botMcpGrants).set({ revokedAt: new Date() }).where(eq(schema.botMcpGrants.id, 'grant-save'));
    await expect(loadMcpApp(p, id)).rejects.toThrow(); expect(fixture.calls).toEqual(['save']);
  });
});

describe('Private HTTP boundary', () => {
  const route = (id: string) => ({ params: Promise.resolve({ id }) });
  it('requires authentication, exact Origin and a bounded strict JSON schema; widgets cannot approve via tools/call', async () => {
    const { id } = await capture();
    const post = (body: unknown, origin = 'https://host.test.invalid') => POST(new Request(`https://host.test.invalid/api/mcp-apps/${id}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }), route(id));
    fixture.human = null; expect((await GET(new Request('https://host.test.invalid'), route(id))).status).toBe(401); fixture.human = p;
    expect((await post({ operation: 'call', ...request() }, 'https://sandbox.test.invalid')).status).toBe(403);
    expect((await post({ operation: 'call', ...request(), approve: true })).status).toBe(400);
    expect((await post({ operation: 'call', ...request(randomUUID(), 'save', { filter: 'x'.repeat(50000) }) })).status).toBe(413);
    const response = await GET(new Request('https://host.test.invalid'), route(id)); expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect((await response.json()).view.result._meta.privateMarker).toBe(privateMarker); expect(fixture.calls).toEqual([]);
  });
});
