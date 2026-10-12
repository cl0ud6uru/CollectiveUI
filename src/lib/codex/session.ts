import { z } from 'zod';
import type { CodexClient, CodexNotification, CodexServerRequest } from './client';
import type { CodexPolicy } from './config';
import type { CodexRuntime } from './runtime';

type Client = Pick<CodexClient, 'request' | 'onNotification' | 'onFailure' | 'onServerRequest' | 'respond' | 'rejectRequest'>;
const id = z.string().min(1).max(256);
const eventBase = z.object({ threadId: id, turnId: id.optional() }).passthrough();
const account = z.object({ account: z.discriminatedUnion('type', [z.object({ type: z.literal('apiKey') }),
  z.object({ type: z.literal('chatgpt'), email: z.string().nullable(), planType: z.string() })]).nullable() });
const modelList = z.object({ data: z.array(z.object({ model: z.string(), supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })) })), nextCursor: z.string().nullable() });
const started = z.object({ thread: z.object({ id, turns: z.array(z.object({ id, status: z.string() })).optional() }), model: z.string(), modelProvider: z.string(), cwd: z.string(),
  approvalPolicy: z.literal('on-request'), approvalsReviewer: z.literal('user'),
  sandbox: z.object({ type: z.enum(['readOnly', 'workspaceWrite']), networkAccess: z.literal(false) }),
  activePermissionProfile: z.object({ id: z.string(), extends: z.string().nullable().optional() }).nullable().optional() });

export type CodexTokenUsage = { inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningOutputTokens: number };
export type SessionHooks = {
  clientMessageId?: string;
  baselineUsage?: CodexTokenUsage | null;
  totalUsage?: (usage: CodexTokenUsage) => void;
  checkpoint: (values: { threadId?: string; turnId?: string; baselineTurnId?: string; phase: 'ready' | 'dispatching' | 'running' | 'terminal' }) => Promise<void>;
  resumeThreadId?: string;
  tool?: (item: NativeToolItem, phase: 'started' | 'completed') => void;
  approval?: (request: CodexServerRequest, signal: AbortSignal) => Promise<'decline' | 'cancel'>;
  text: (itemId: string, delta: string) => void;
  usage?: (usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningOutputTokens: number }) => void;
  authorizeAccount?: (identity: z.infer<typeof account>['account']) => Promise<void>;
};

export type NativeToolItem = { id: string; type: 'commandExecution' | 'fileChange'; command?: string; cwd?: string;
  status?: string; aggregatedOutput?: string; exitCode?: number | null; changes?: { path: string; diff: string }[] };
const nativeTool = z.discriminatedUnion('type', [
  z.object({ id, type: z.literal('commandExecution'), command: z.string().max(16384), cwd: z.string().max(4096),
    status: z.string(), aggregatedOutput: z.string().max(1024 * 1024).nullable().optional(), exitCode: z.number().int().nullable().optional() }),
  z.object({ id, type: z.literal('fileChange'), status: z.string(), changes: z.array(z.object({ path: z.string().max(4096), diff: z.string().max(1024 * 1024) })).max(256) }),
]);
/** Managed agent sessions retain native history; legacy manifest runtimes remain text-only. */
export async function executeCodexSession(client: Client, runtime: CodexRuntime, policy: CodexPolicy,
  input: string, instructions: string, hooks: SessionHooks, signal: AbortSignal) {
  let accountEpoch = 0, verifiedEpoch = -1;
  let accountFailure: Error | undefined, accountVerification: Promise<void> | undefined;
  const unwatchAccount = client.onNotification(e => { if (e.method === 'account/updated') accountEpoch++; });
  const verifyCurrentAccount = async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      signal.throwIfAborted();
      if (accountFailure) throw accountFailure;
      const epoch = accountEpoch;
      const response = await client.request('account/read', { refreshToken: false });
      const identity = account.parse(response).account;
      if (runtime.managed) {
        const { nativeAccount } = await import('@/personal-codex/contracts');
        const facts = nativeAccount.parse(response);
        if (facts.workspaceRouting?.chatgptAccountId !== runtime.expectedWorkspaceId)
          throw new Error('The selected Codex workspace changed. Reconnect your account.');
      }
      if (!identity || (runtime.funding === 'api' ? identity.type !== 'apiKey' :
        identity.type !== 'chatgpt' || identity.email?.toLowerCase() !== runtime.expectedEmail?.toLowerCase()))
        throw new Error('The Codex runtime account does not match your assigned funding and identity.');
      if (!runtime.managed && accountEpoch) throw new Error('The Codex runtime account changed during this request.');
      await hooks.authorizeAccount?.(identity);
      if (epoch === accountEpoch) { verifiedEpoch = epoch; return; }
    }
    throw new Error('The Codex runtime account kept changing during this request.');
  };
  const verifyAccount = () => {
    if (accountVerification) return accountVerification;
    const check = verifyCurrentAccount().catch(err => {
      accountFailure = err instanceof Error ? err : new Error('Codex account verification failed.'); throw accountFailure;
    }).finally(() => { if (accountVerification === check) accountVerification = undefined; });
    accountVerification = check;
    return check;
  };
  try {
    await verifyAccount();
    // Inspect the effective config, including project config, before creating a thread. Do not inherit external tools.
    const { config } = z.object({ config: z.record(z.string(), z.unknown()) }).parse(await client.request('config/read', { includeLayers: false, cwd: runtime.cwd }));
    if (runtime.funding === 'chatgpt_subscription' && !runtime.managed) {
      const restricted = config.forced_chatgpt_workspace_id;
      const workspaces = typeof restricted === 'string' ? [restricted] : restricted;
      if (!Array.isArray(workspaces) || workspaces.length !== 1 || workspaces[0] !== runtime.expectedWorkspaceId || config.forced_login_method !== 'chatgpt')
        throw new Error('The Codex runtime must enforce your authorized ChatGPT workspace and login method.');
    }
    if (runtime.managed) {
      const { requirements } = z.object({ requirements: z.object({ defaultPermissions: z.literal('collective-personal'),
        allowedPermissionProfiles: z.record(z.string(), z.boolean()), allowedLoginMethods: z.array(z.literal('chatgpt')),
        allowedApprovalsReviewers: z.array(z.literal('user')), allowedApprovalPolicies: z.array(z.literal('on-request')) }) }).parse(await client.request('configRequirements/read', {}));
      if (Object.keys(requirements.allowedPermissionProfiles).length !== 1 || requirements.allowedPermissionProfiles['collective-personal'] !== true ||
        config.forced_login_method !== 'chatgpt' || (Array.isArray(config.notify) && config.notify.length)) throw new Error('The managed Codex permission contract changed.');
    }
    for (const key of ['mcp_servers', 'plugins', 'apps']) {
      if (config[key] && Object.keys(config[key] as object).length) throw new Error('This Codex pilot requires a runtime without configured MCP servers, apps or plugins.');
    }
    let selected = false, cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const catalog = modelList.parse(await client.request('model/list', { limit: 100, cursor }));
      selected = catalog.data.some(m => m.model === policy.model && m.supportedReasoningEfforts.some(e => e.reasoningEffort === policy.effort));
      if (selected || !catalog.nextCursor) break;
      cursor = catalog.nextCursor;
    }
    if (!selected) throw new Error('Your Codex runtime does not offer the selected model and reasoning effort.');
    signal.throwIfAborted();
    const thread = started.parse(await client.request(hooks.resumeThreadId ? 'thread/resume' : 'thread/start', {
      ...(hooks.resumeThreadId ? { threadId: hooks.resumeThreadId } : runtime.managed ? { historyMode: 'legacy' } : {}),
      model: policy.model, modelProvider: 'openai', cwd: runtime.cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user',
      ...(runtime.managed ? { permissions: 'collective-personal' } : { sandbox: 'read-only' }), ephemeral: false, developerInstructions: instructions,
      config: { service_tier: 'default', web_search: 'disabled', notify: [],
        ...(runtime.managed ? { forced_login_method: 'chatgpt', forced_chatgpt_workspace_id: runtime.expectedWorkspaceId } : {}),
        projects: { [runtime.cwd]: { trust_level: 'untrusted' } }, 'features.hooks': false, 'features.memories': false, 'features.shell_snapshot': false,
        'features.shell_tool': runtime.managed === true, 'features.view_image': false, 'features.multi_agent': false,
        'features.multi_agent_v2': false, 'features.plugins': false, 'features.plugin_hooks': false,
        'features.enable_mcp_apps': false, 'features.image_generation': false },
    }));
    if (thread.model !== policy.model || thread.modelProvider !== 'openai' || thread.cwd !== runtime.cwd)
      throw new Error('Codex did not honor the selected model or workspace.');
    if (runtime.managed && (thread.activePermissionProfile?.id !== 'collective-personal' || thread.sandbox.type !== 'workspaceWrite'))
      throw new Error('Codex did not honor the managed workspace permission profile.');
    if (!runtime.managed && thread.sandbox.type !== 'readOnly') throw new Error('The text runtime did not honor read-only permissions.');
    if (hooks.resumeThreadId && (thread.thread.id !== hooks.resumeThreadId || !thread.thread.turns || thread.thread.turns.some(t => t.status === 'inProgress')))
      throw new Error('The retained Codex thread could not be safely resumed.');
    await hooks.checkpoint({ threadId: thread.thread.id, baselineTurnId: thread.thread.turns?.at(-1)?.id, phase: 'ready' });
    const threadId = thread.thread.id;
    let turnId: string | undefined, finished = false, completing = false, bytes = 0;
    let pending: CodexNotification[] = [];
    let pendingRequests: CodexServerRequest[] = [];
    const requests = new Map<string | number, AbortController>();
    const resolvedRequests = new Set<string | number>();
    const approvalStop = new AbortController();
    const nativeItems = new Set<string>();
    const emittedText = new Map<string, string>();
    let resolve!: () => void, reject!: (e: Error) => void;
    const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // Attach rejection handling before any await; notifications/abort can race the turn/start response.
    void completion.catch(() => {});
    const fail = (e: Error) => { if (!finished) { finished = true; reject(e); } };
    const project = (e: CodexNotification) => {
      if (finished) return;
      try {
        if (e.method === 'account/updated') {
          // Managed servers also publish an initial/refresh snapshot. Reread bound facts instead of treating it as proof of an account switch.
          if (!runtime.managed) throw new Error('The Codex runtime account changed during this request.');
          void verifyAccount().catch(err => fail(err instanceof Error ? err : new Error('Codex account verification failed.')));
          return;
        }
        const parsed = eventBase.safeParse(e.params);
        if (!parsed.success || parsed.data.threadId !== threadId) return;
        if (!turnId) {
          bytes += JSON.stringify(e).length;
          if (bytes > 1024 * 1024 || pending.length >= 1024) throw new Error('Codex sent too many events before acknowledging the turn.');
          pending.push(e); return;
        }
        const p = parsed.data;
        if (e.method === 'serverRequest/resolved') {
          const resolved = z.object({ requestId: z.union([z.string(), z.number()]) }).parse(p);
          resolvedRequests.add(resolved.requestId); requests.get(resolved.requestId)?.abort(); return;
        }
        if (e.method === 'turn/completed') {
          const turn = z.object({ turn: z.object({ id, status: z.string() }) }).parse(p).turn;
          if (turn.id !== turnId) return;
          if (turn.status !== 'completed') throw new Error(turn.status === 'interrupted' ? 'Codex was stopped.' : 'Codex did not complete this turn.');
          if (!completing) {
            completing = true;
            // A terminal notification cannot outrun a pending identity/workspace recheck.
            void verifyAccount().then(() => { if (!finished) { finished = true; resolve(); } }).catch(fail);
          }
          return;
        }
        if (p.turnId !== turnId) return;
        if (e.method === 'item/agentMessage/delta') {
          const d = z.object({ itemId: id, delta: z.string() }).parse(p);
          bytes += d.delta.length;
          if (bytes > 2 * 1024 * 1024) throw new Error('The Codex response exceeded this pilot’s limit.');
          emittedText.set(d.itemId, (emittedText.get(d.itemId) ?? '') + d.delta);
          hooks.text(d.itemId, d.delta);
        } else if (e.method === 'item/started' || e.method === 'item/completed') {
          const item = z.object({ item: z.object({ type: z.string(), id: id.optional(), text: z.string().optional() }) }).parse(p).item;
          if (e.method === 'item/completed' && item.type === 'agentMessage' && item.id && item.text !== undefined) {
            const previous = emittedText.get(item.id) ?? '';
            if (!item.text.startsWith(previous)) throw new Error('Codex returned inconsistent message events.');
            const remaining = item.text.slice(previous.length);
            bytes += remaining.length;
            if (bytes > 2 * 1024 * 1024) throw new Error('The Codex response exceeded this pilot’s limit.');
            if (remaining) { emittedText.set(item.id, item.text); hooks.text(item.id, remaining); }
          }
          if (runtime.managed && ['commandExecution', 'fileChange'].includes(item.type)) {
            const tool = nativeTool.parse(p.item);
            bytes += JSON.stringify(tool).length; nativeItems.add(tool.id);
            if (bytes > 4 * 1024 * 1024 || nativeItems.size > 512) throw new Error('Codex tool output exceeded this pilot’s limit.');
            hooks.tool?.(tool.type === 'commandExecution' ? { ...tool, aggregatedOutput: tool.aggregatedOutput ?? undefined } : tool, e.method === 'item/started' ? 'started' : 'completed');
            return;
          }
          if (!['userMessage', 'agentMessage', 'reasoning', 'plan', 'contextCompaction'].includes(item.type))
            throw new Error('Codex requested a native tool that is not supported by this text-only pilot.');
        } else if (e.method === 'thread/tokenUsage/updated') {
          const count = z.number().int().nonnegative().safe();
          const usage = z.object({ tokenUsage: z.object({ total: z.object({ inputTokens: count, outputTokens: count, cachedInputTokens: count, reasoningOutputTokens: count }) }) }).parse(p);
          const total = usage.tokenUsage.total;
          hooks.totalUsage?.(total);
          const baseline = hooks.resumeThreadId ? hooks.baselineUsage : { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 };
          if (baseline) {
            const delta = Object.fromEntries(Object.entries(total).map(([key, value]) => [key, value - baseline[key as keyof CodexTokenUsage]])) as CodexTokenUsage;
            if (Object.values(delta).every(value => value >= 0)) hooks.usage?.(delta);
          }
        } else if (e.method === 'error' && (p as { willRetry?: boolean }).willRetry !== true) throw new Error('Codex reported an upstream error. Start a new request after checking your runtime.');
      } catch (err) { fail(err instanceof Error ? err : new Error('Invalid Codex event.')); }
    };
    const handleRequest = (r: CodexServerRequest) => {
      if (resolvedRequests.has(r.id)) return;
      if (finished) { client.rejectRequest(r.id); return; }
      if (!turnId) { if (pendingRequests.length >= 16) { client.rejectRequest(r.id); fail(new Error('Too many Codex approval requests.')); } else pendingRequests.push(r); return; }
      const p = z.object({ threadId: id, turnId: id, itemId: id }).safeParse(r.params);
      if (!runtime.managed || !p.success || p.data.threadId !== threadId || p.data.turnId !== turnId ||
        !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(r.method) || requests.has(r.id) || !hooks.approval) {
        client.rejectRequest(r.id); fail(new Error('Codex requested an unsupported approval or interactive tool.')); return;
      }
      const requestStop = new AbortController(); requests.set(r.id, requestStop);
      const requestSignal = AbortSignal.any([signal, approvalStop.signal, requestStop.signal]);
      void hooks.approval(r, requestSignal).then(async decision => {
        if (finished || requestSignal.aborted || accountFailure) return;
        if (accountEpoch !== verifiedEpoch) await verifyAccount();
        if (finished || requestSignal.aborted) return;
        // Initial pilot offers only explicit decline/cancel; no permission or network expansion.
        client.respond(r.id, { decision });
      }).catch(() => fail(new Error('Codex approval could not be completed safely.')));
    };
    const unsubscribe = client.onNotification(project), unfailed = client.onFailure(fail);
    const unrequests = client.onServerRequest(handleRequest);
    const abort = () => fail(new Error('Codex was stopped.'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      // Persist uncertainty BEFORE the wire write. No retry is safe after this checkpoint.
      await verifyAccount();
      await hooks.checkpoint({ phase: 'dispatching' });
      if (accountEpoch !== verifiedEpoch) await verifyAccount();
      signal.throwIfAborted();
      const response = z.object({ turn: z.object({ id }) }).parse(await client.request('turn/start', {
        threadId, clientUserMessageId: hooks.clientMessageId, input: [{ type: 'text', text: input, text_elements: [] }], model: policy.model, effort: policy.effort,
        serviceTierForTurn: 'default', approvalPolicy: 'on-request', approvalsReviewer: 'user',
        ...(runtime.managed ? { permissions: 'collective-personal' } : { sandboxPolicy: { type: 'readOnly', networkAccess: false } }),
      }));
      turnId = response.turn.id;
      await hooks.checkpoint({ turnId, phase: 'running' });
      const early = pending; pending = []; bytes = 0;
      for (const e of early) project(e);
      const earlyRequests = pendingRequests; pendingRequests = []; for (const r of earlyRequests) handleRequest(r);
      await completion;
      await hooks.checkpoint({ phase: 'terminal' });
    } finally { approvalStop.abort(); unsubscribe(); unfailed(); unrequests(); signal.removeEventListener('abort', abort); }
  } finally { unwatchAccount(); }
}
