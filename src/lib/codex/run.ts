import { getOwnedConversation, HttpError } from '@/lib/authz';
// Shared by the Next server and plain Node worker; this builtin rejects browser bundles.
import 'node:async_hooks';
import type { UIMessageChunk, DynamicToolUIPart } from 'ai';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { codexThreads } from '@/db/schema';
import { runtimeBinding as binding } from './binding';
import { waitForApproval } from '@/personal-codex/approvals';
import type { TurnOptions, TurnResult } from '@/lib/agent/run';
import type { PortalUIMessage } from '@/lib/chat/store';
import { CODEX_DIRECT_ONLY, CodexPolicySchema } from './config';
import { CodexClient } from './client';
import { callerRuntime } from './runtime';
import { executeCodexSession } from './session';
import { checkpointCodexRun, reserveCodexRun } from './store';
import { runtimeBinding, assertRuntimeOwner } from './runtime';
import { loadPrincipal } from '@/lib/auth/groups';
import { resolveTurnTarget } from '@/lib/agent/target';
import { mapUsage, recordUsage } from '@/lib/llm/usage';
import { accountRejection, userMayUseChatGPT } from '@/lib/llm/chatgpt/policy';
import { getSetting } from '@/lib/settings';
import { personalAccount } from '@/personal-codex/accounts';
import { managedComputerAgent } from '@/lib/computer/agent';
import { webSessionRegistryEnabled } from '@/lib/auth/web-sessions';

export async function runCodexTurn(opts: TurnOptions): Promise<TurnResult> {
  if (!opts.bot || !opts.run?.holder || !opts.persist || !opts.responseMessageId || opts.continuation || opts.background || opts.delegation ||
    opts.conversation.userId !== opts.principal.user.id || opts.bot.executionMode !== 'caller' || opts.run.segment !== 0)
    throw new HttpError(409, CODEX_DIRECT_ONLY);
  if (opts.history.some(m => m.parts.some(p => p.type === 'file'))) throw new HttpError(409, CODEX_DIRECT_ONLY);
  const raw = opts.app.providerConfig ?? {};
  const policy = CodexPolicySchema.parse({ funding: raw.funding, model: raw.model, effort: raw.effort });
  const transcript = JSON.stringify(opts.history.map(m => ({ role: m.role, text: m.parts.filter(p => p.type === 'text').map(p => p.text).join('\n') })));
  if (transcript.length > 200000) throw new HttpError(409, 'This chat is too long for the Codex pilot. Start a new chat.');
  const runtime = await callerRuntime(opts.principal.user.id, policy.funding);
  assertRuntimeOwner(runtime, opts.principal.user);
  if (!runtime.managed && opts.history.some(m => m.parts.some(p => p.type.startsWith('tool-') || p.type === 'dynamic-tool')))
    throw new HttpError(409, CODEX_DIRECT_ONLY);
  const [retained] = runtime.managed ? await db.select().from(codexThreads).where(and(eq(codexThreads.conversationId, opts.conversation.id), eq(codexThreads.userId, runtime.ownerId))) : [];
  if (retained && (retained.binding !== binding(runtime) || retained.appId !== opts.app.id || retained.lastMessageId !== opts.history.at(-2)?.id))
    throw new HttpError(409, 'This Codex chat belongs to a different account, bot revision or conversation branch. Start a new chat.');
  const connectedAccount = runtime.managed ? await personalAccount(runtime.ownerId) : undefined;
  const computerAgent = runtime.managed && connectedAccount?.credentialBinding === runtime.credentialBinding &&
    opts.app.providerConfig?.codexHarness === true && opts.bot.executionMode === 'caller' && !opts.bot.hermesTeam
    ? await managedComputerAgent(runtime) : null;
  const authorizeComputerCall = async () => {
    if (!computerAgent || !runtime.managed || process.env.COMPUTER_VIEW_ENABLED !== '1' || !webSessionRegistryEnabled())
      throw new HttpError(403, 'Computer tools are unavailable for this Codex session.');
    const fresh = await loadPrincipal(opts.principal.user.id);
    if (!fresh || fresh.user.sessionVersion !== opts.principal.user.sessionVersion) throw new HttpError(403, 'Your Codex access changed during this turn.');
    const conversation = await getOwnedConversation(fresh, opts.conversation.id);
    if (conversation.source !== 'chat' || conversation.isGroup || conversation.botId !== opts.bot!.id)
      throw new HttpError(403, 'This Codex conversation is no longer authorized.');
    const target = await resolveTurnTarget(fresh, conversation);
    if (!target.bot || target.bot.id !== opts.bot!.id || target.bot.executionMode !== 'caller' || target.bot.hermesTeam ||
        target.app.id !== opts.app.id || target.app.providerConfig?.codexHarness !== true)
      throw new HttpError(403, 'This Codex computer is no longer authorized.');
    const currentRuntime = await callerRuntime(fresh.user.id, policy.funding);
    assertRuntimeOwner(currentRuntime, fresh.user);
    const currentAccount = currentRuntime.managed ? await personalAccount(fresh.user.id) : undefined;
    if (!currentRuntime.managed || runtimeBinding(currentRuntime) !== runtimeBinding(runtime) || currentRuntime.socketPath !== runtime.socketPath ||
        !currentAccount || currentAccount.credentialBinding !== runtime.credentialBinding)
      throw new HttpError(403, 'The connected Codex account changed during this turn.');
  };
  await reserveCodexRun(opts.run, runtime);
  const cancelled = new AbortController();
  const signal = AbortSignal.any([opts.abortSignal ?? AbortSignal.timeout(30 * 60 * 1000), cancelled.signal]);
  const source = policy.funding === 'api' ? 'codex_api' as const : 'chatgpt_plan' as const;
  const responseMessage: PortalUIMessage = { id: opts.responseMessageId, role: 'assistant', parts: [] };
  let resolveDone!: (v: Awaited<TurnResult['done']>) => void;
  const done: TurnResult['done'] = new Promise(resolve => { resolveDone = resolve; });
  let closed = false;
  const stream = new ReadableStream<UIMessageChunk>({ start(controller) {
    const emit = (chunk: UIMessageChunk) => { if (!closed) controller.enqueue(chunk); };
    // The durable worker owns this stream; browser disconnection only stops its event-log tail.
    void (async () => {
      let client: CodexClient | undefined, error: string | undefined;
      let tokens = mapUsage(undefined), dispatched = false;
      let tokenTotals: import('./session').CodexTokenUsage | undefined;
      const abortTransport = () => client?.close();
      signal.addEventListener('abort', abortTransport, { once: true });
      const text = new Map<string, { type: 'text'; text: string; state: 'streaming' | 'done' }>();
      emit({ type: 'start', messageId: responseMessage.id });
      try {
        signal.throwIfAborted();
        client = await CodexClient.connect(runtime);
        await executeCodexSession(client, runtime, policy,
          runtime.managed && retained ? opts.history.at(-1)!.parts.filter(p => p.type === 'text').map(p => p.text).join('\n') : `Conversation transcript (JSON). Respond to the last user message.\n${transcript}`,
          [opts.bot!.instructions, opts.bot!.boundaries, runtime.managed ? 'Execute useful commands and file edits inside your personal workspace. Protected auth storage and external tools are unavailable. Permission expansion requires review; this pilot permits decline or stop only.' : 'This is a text-only CollectiveUI session. Do not invoke tools or request approvals.',
            computerAgent ? 'The account-owned computer is available through the computer tools. Use screenshots and bounded click, type, key, and scroll actions when useful. If a sign-in, secret, or sensitive account decision is required, pause and ask the user; never ask them to send passwords, codes, or secrets in chat. Human takeover pauses computer input until control is released.' : 'No computer tools are available in this session.'].filter(Boolean).join('\n\n'), {
            resumeThreadId: retained?.threadId, clientMessageId: opts.run!.id, baselineUsage: retained?.tokenTotals,
            computerAgent, authorizeComputerCall,
            totalUsage: u => { tokenTotals = u; },
            authorizeAccount: async identity => {
              if (identity?.type === 'chatgpt') {
                const settings = await getSetting('chatgpt');
                const reason = accountRejection({ accountId: runtime.expectedWorkspaceId!, planType: identity.planType }, settings);
                if (!userMayUseChatGPT(opts.principal, settings) || reason) throw new HttpError(403, reason ?? 'Personal ChatGPT access is unavailable.');
              }
            },
            checkpoint: async values => {
              if (values.phase === 'dispatching') {
                const fresh = await loadPrincipal(opts.principal.user.id);
                if (!fresh || fresh.user.sessionVersion !== opts.principal.user.sessionVersion ||
                  (await resolveTurnTarget(fresh, opts.conversation)).app.id !== opts.app.id ||
                  runtimeBinding(await callerRuntime(fresh.user.id, policy.funding)) !== runtimeBinding(runtime))
                  throw new HttpError(409, 'Your Codex access or runtime binding changed before dispatch.');
                assertRuntimeOwner(runtime, fresh.user);
              }
              await checkpointCodexRun(opts.run!, runtime.ownerId, values);
              if (runtime.managed && values.threadId) await db.insert(codexThreads).values({ conversationId: opts.conversation.id,
                userId: runtime.ownerId, binding: binding(runtime), appId: opts.app.id, threadId: values.threadId, lastMessageId: retained?.lastMessageId ?? null })
                .onConflictDoUpdate({ target: codexThreads.conversationId, set: { threadId: values.threadId, updatedAt: new Date() } });
              if (values.phase === 'dispatching') dispatched = true;
            },
            tool: (item, phase) => {
              let part = responseMessage.parts.find(p => p.type === 'dynamic-tool' && p.toolCallId === item.id) as DynamicToolUIPart | undefined;
              const input = item.type === 'commandExecution' ? { command: item.command, cwd: item.cwd } : { changes: item.changes };
              if (!part) {
                part = { type: 'dynamic-tool', toolCallId: item.id, toolName: `codex_${item.type}`, state: 'input-available', input };
                responseMessage.parts.push(part);
                emit({ type: 'tool-input-available', toolCallId: item.id, toolName: part.toolName, input, dynamic: true });
              }
              if (phase === 'completed') {
                const output = item.type === 'commandExecution' ? { status: item.status, stdout: item.aggregatedOutput ?? '', exitCode: item.exitCode } : { status: item.status, changes: item.changes };
                const complete: DynamicToolUIPart = { type: 'dynamic-tool', toolCallId: item.id, toolName: part.toolName, state: 'output-available', input, output };
                Object.assign(part, complete); emit({ type: 'tool-output-available', toolCallId: item.id, output, dynamic: true });
              }
            },
            computerTool: (callId, toolName, phase, success) => {
              let part = responseMessage.parts.find(p => p.type === 'dynamic-tool' && p.toolCallId === callId) as DynamicToolUIPart | undefined;
              const input = {};
              if (!part) {
                part = { type: 'dynamic-tool', toolCallId: callId, toolName, state: 'input-available', input };
                responseMessage.parts.push(part);
                emit({ type: 'tool-input-available', toolCallId: callId, toolName, input, dynamic: true });
              }
              if (phase === 'completed') {
                const output = { success: success === true };
                const complete: DynamicToolUIPart = { type: 'dynamic-tool', toolCallId: callId, toolName, state: 'output-available', input, output };
                Object.assign(part, complete);
                emit({ type: 'tool-output-available', toolCallId: callId, output, dynamic: true });
              }
            },
            approval: async (request, approvalSignal) => {
              const p = request.params as { threadId: string; turnId: string; itemId: string; command?: string; reason?: string };
              const label = request.method === 'item/commandExecution/requestApproval' ? 'Command requires broader permissions' : 'File edit requires broader permissions';
              let approvalId: string | undefined;
              const decision = await waitForApproval(opts.run!.id, runtime, p.threadId, p.turnId, approvalSignal, id => {
                approvalId = id;
                const part = { type: 'data-codex-approval' as const, id, data: { id, label, state: 'pending' } };
                responseMessage.parts.push(part); emit(part);
              });
              const part = responseMessage.parts.find(p => p.type === 'data-codex-approval' && p.id === approvalId);
              if (part?.type === 'data-codex-approval') { (part.data as { state: string }).state = decision; emit({ type: 'data-codex-approval', id: part.id, data: part.data }); }
              return decision;
            },
            usage: u => { tokens = mapUsage({ inputTokens: { total: u.inputTokens, cacheRead: u.cachedInputTokens }, outputTokens: { total: u.outputTokens, reasoning: u.reasoningOutputTokens } }); },
            text: (id, delta) => {
              let part = text.get(id);
              if (!part) { part = { type: 'text', text: '', state: 'streaming' }; text.set(id, part); responseMessage.parts.push(part); emit({ type: 'text-start', id }); }
              part.text += delta; emit({ type: 'text-delta', id, delta });
            },
          }, signal);
      } catch (err) {
        error = signal.aborted ? 'Codex was stopped.' : err instanceof Error && !err.name.startsWith('Zod') ? err.message : 'The Codex runtime returned an unsupported response.';
        // Upstream errors are already replaced at the transport boundary. Never include endpoints or tokens.
        client?.close(); client = undefined;
        // The executor and sweeper reconcile this durable attempt after closing the stream.
        // Do not hold the UI's cancellation deadline hostage to an unreachable upstream.

      } finally {
        signal.removeEventListener('abort', abortTransport);
        client?.close();
        for (const part of responseMessage.parts) {
          if (part.type === 'data-codex-approval' && (part.data as { state: string }).state === 'pending') {
            (part.data as { state: string }).state = 'cancel'; emit({ type: 'data-codex-approval', id: part.id, data: part.data });
          }
        }
        for (const [id, part] of text) { part.state = 'done'; emit({ type: 'text-end', id }); }
        if (error) emit({ type: 'error', errorText: error });
        if (dispatched) await recordUsage({ purpose: 'chat', billingSource: source, providerKind: opts.app.provider,
          model: policy.model, appId: opts.app.id, userId: runtime.ownerId, conversationId: opts.conversation.id,
          botId: opts.bot!.id, credentialId: runtime.id, billingRoute: `codex:${policy.funding}`,
          scope: { pending: [], runId: opts.run!.id, messageId: responseMessage.id } }, tokens);
        try {
          await opts.persist!({ conversationId: opts.conversation.id, userId: opts.principal.user.id, botId: opts.bot!.id,
            runId: opts.run!.id, responseMessage, isContinuation: false, parentId: opts.history.at(-1)?.id ?? null,
            extra: { model: policy.model, inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens, billingSource: source, providerKind: opts.app.provider, appId: opts.app.id },
            // No company-funded memory/title side-call for caller-owned Codex execution.
            background: true }, { error });
          if (runtime.managed) await db.update(codexThreads).set({ lastMessageId: responseMessage.id, tokenTotals: dispatched && error ? null : tokenTotals, updatedAt: new Date() })
            .where(and(eq(codexThreads.conversationId, opts.conversation.id), eq(codexThreads.binding, binding(runtime))));
        } catch { error = 'The Codex response could not be saved.'; }
        emit({ type: 'finish', finishReason: error ? 'error' : 'stop' }); if (!closed) controller.close(); closed = true;
        resolveDone({ responseMessage, pendingApproval: false, error });
      }
    })();
  }, cancel() { closed = true; cancelled.abort(); } });
  return { stream, done, billing: { source } };
}
