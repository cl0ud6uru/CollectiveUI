import { z } from 'zod';
import type { CodexClient, CodexNotification } from './client';
import type { CodexPolicy } from './config';
import type { CodexRuntime } from './runtime';

type Client = Pick<CodexClient, 'request' | 'onNotification' | 'onFailure'>;
const id = z.string().min(1).max(256);
const eventBase = z.object({ threadId: id, turnId: id.optional() }).passthrough();
const account = z.object({ account: z.discriminatedUnion('type', [z.object({ type: z.literal('apiKey') }),
  z.object({ type: z.literal('chatgpt'), email: z.string().nullable(), planType: z.string() })]).nullable() });
const modelList = z.object({ data: z.array(z.object({ model: z.string(), supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })) })), nextCursor: z.string().nullable() });
const started = z.object({ thread: z.object({ id }), model: z.string(), modelProvider: z.string(), cwd: z.string(),
  approvalPolicy: z.literal('on-request'), approvalsReviewer: z.literal('user'),
  sandbox: z.object({ type: z.literal('readOnly'), networkAccess: z.literal(false) }) });

export type SessionHooks = {
  checkpoint: (values: { threadId?: string; turnId?: string; phase: 'ready' | 'dispatching' | 'running' | 'terminal' }) => Promise<void>;
  text: (itemId: string, delta: string) => void;
  usage?: (usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningOutputTokens: number }) => void;
  authorizeAccount?: (identity: z.infer<typeof account>['account']) => Promise<void>;
};

/** Text-only pilot: native tool/attachment bridges require their own authorization and sandbox implementation. */
export async function executeCodexSession(client: Client, runtime: CodexRuntime, policy: CodexPolicy,
  input: string, instructions: string, hooks: SessionHooks, signal: AbortSignal) {
  let accountChanged = false;
  const unwatchAccount = client.onNotification(e => { if (e.method === 'account/updated') accountChanged = true; });
  const verifyAccount = async () => {
  signal.throwIfAborted();
  const identity = account.parse(await client.request('account/read', { refreshToken: false })).account;
  if (!identity || (runtime.funding === 'api' ? identity.type !== 'apiKey' :
    identity.type !== 'chatgpt' || identity.email?.toLowerCase() !== runtime.expectedEmail?.toLowerCase()))
    throw new Error('The Codex runtime account does not match your assigned funding and identity.');
  if (accountChanged) throw new Error('The Codex runtime account changed during this request.');
  await hooks.authorizeAccount?.(identity);
  };
  try {
    await verifyAccount();
    // Inspect the effective config, including project config, before creating a thread. Do not inherit external tools.
    const { config } = z.object({ config: z.record(z.string(), z.unknown()) }).parse(await client.request('config/read', { includeLayers: false, cwd: runtime.cwd }));
    if (runtime.funding === 'chatgpt_subscription') {
      const restricted = config.forced_chatgpt_workspace_id;
      const workspaces = typeof restricted === 'string' ? [restricted] : restricted;
      if (!Array.isArray(workspaces) || workspaces.length !== 1 || workspaces[0] !== runtime.expectedWorkspaceId || config.forced_login_method !== 'chatgpt')
        throw new Error('The Codex runtime must enforce your authorized ChatGPT workspace and login method.');
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
    const thread = started.parse(await client.request('thread/start', {
      model: policy.model, modelProvider: 'openai', cwd: runtime.cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user',
      sandbox: 'read-only', ephemeral: false, developerInstructions: instructions,
      config: { service_tier: 'default', web_search: 'disabled',
        'features.shell_tool': false, 'features.view_image': false, 'features.multi_agent': false,
        'features.multi_agent_v2': false, 'features.plugins': false, 'features.plugin_hooks': false,
        'features.enable_mcp_apps': false, 'features.image_generation': false },
    }));
    if (thread.model !== policy.model || thread.modelProvider !== 'openai' || thread.cwd !== runtime.cwd)
      throw new Error('Codex did not honor the selected model or workspace.');
    await hooks.checkpoint({ threadId: thread.thread.id, phase: 'ready' });
    const threadId = thread.thread.id;
    let turnId: string | undefined, finished = false, bytes = 0;
    let pending: CodexNotification[] = [];
    const emittedText = new Map<string, string>();
    let resolve!: () => void, reject!: (e: Error) => void;
    const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // Attach rejection handling before any await; notifications/abort can race the turn/start response.
    void completion.catch(() => {});
    const fail = (e: Error) => { if (!finished) { finished = true; reject(e); } };
    const project = (e: CodexNotification) => {
      if (finished) return;
      try {
        if (e.method === 'account/updated') throw new Error('The Codex runtime account changed during this request.');
        const parsed = eventBase.safeParse(e.params);
        if (!parsed.success || parsed.data.threadId !== threadId) return;
        if (!turnId) {
          bytes += JSON.stringify(e).length;
          if (bytes > 1024 * 1024 || pending.length >= 1024) throw new Error('Codex sent too many events before acknowledging the turn.');
          pending.push(e); return;
        }
        const p = parsed.data;
        if (e.method === 'turn/completed') {
          const turn = z.object({ turn: z.object({ id, status: z.string() }) }).parse(p).turn;
          if (turn.id !== turnId) return;
          if (turn.status !== 'completed') throw new Error('Codex did not complete this turn.');
          finished = true; resolve(); return;
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
          if (!['userMessage', 'agentMessage', 'reasoning', 'plan', 'contextCompaction'].includes(item.type))
            throw new Error('Codex requested a native tool that is not supported by this text-only pilot.');
        } else if (e.method === 'thread/tokenUsage/updated') {
          const count = z.number().int().nonnegative().safe();
          const usage = z.object({ tokenUsage: z.object({ total: z.object({ inputTokens: count, outputTokens: count, cachedInputTokens: count, reasoningOutputTokens: count }) }) }).parse(p);
          hooks.usage?.(usage.tokenUsage.total);
        } else if (e.method === 'error') throw new Error('Codex reported an upstream error. Start a new request after checking your runtime.');
      } catch (err) { fail(err instanceof Error ? err : new Error('Invalid Codex event.')); }
    };
    const unsubscribe = client.onNotification(project), unfailed = client.onFailure(fail);
    const abort = () => fail(new Error('Codex was stopped.'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      // Persist uncertainty BEFORE the wire write. No retry is safe after this checkpoint.
      await verifyAccount();
      await hooks.checkpoint({ phase: 'dispatching' });
      if (accountChanged) throw new Error('The Codex runtime account changed during this request.');
      signal.throwIfAborted();
      const response = z.object({ turn: z.object({ id }) }).parse(await client.request('turn/start', {
        threadId, input: [{ type: 'text', text: input, text_elements: [] }], model: policy.model, effort: policy.effort,
        serviceTierForTurn: 'default', approvalPolicy: 'on-request', approvalsReviewer: 'user',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      }));
      turnId = response.turn.id;
      await hooks.checkpoint({ turnId, phase: 'running' });
      const early = pending; pending = []; bytes = 0;
      for (const e of early) project(e);
      await completion;
      await hooks.checkpoint({ phase: 'terminal' });
    } finally { unsubscribe(); unfailed(); signal.removeEventListener('abort', abort); }
  } finally { unwatchAccount(); }
}
