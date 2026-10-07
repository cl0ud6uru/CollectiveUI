import { InvalidToolApprovalSignatureError } from "ai";
import { convertToModelMessages, createUIMessageStream, isStepCount, streamText, toUIMessageStream, type UIMessageChunk } from "ai";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { conversations, type AiApp, type Bot, type Conversation } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { partsToText, type PortalUIMessage } from "@/lib/chat/store";
import { toolApprovalSecret } from "@/lib/crypto";
import { newId } from "@/lib/ids";
import { redactSecrets } from "@/lib/redact";
import { generateTitle, newUsageScope, resolveModel, userFacingMessage, utilityApp, type BillingSource } from "@/lib/llm";
import type { ResumeState, RunHandle } from "@/lib/runs/types";
import { HttpError } from "@/lib/authz";
import { getSetting } from "@/lib/settings";
import { buildInstructionSections, toModelInstructions } from "./instructions";
import { memoryEnabled, selectMemories } from "./memory";
import { hasPendingApproval, persistAssistantTurn, type PersistTurnInput } from "./persist";
import { resolveAttachmentsForModel } from "./prepare";
import { scrubForeignOpenAIMetadata } from "./replay";
import { buildToolset } from "./toolset";
import { slashInvokedSkill } from "./skill-lookup";
import type { AgentCtx } from "./types";
import type { DelegatedTask } from "@/lib/delegation/store";

export type TurnOptions = {
  delegation?: { task: DelegatedTask; parent?: Pick<AgentCtx, "inGroup" | "workspace">; authorize: () => Promise<void> };
  principal: Principal;
  conversation: Conversation;
  app: AiApp;
  bot: Bot | null;
  /** Branch path ending with the new user message, or with the assistant message being continued. */
  history: PortalUIMessage[];
  /** True when the last history message is an assistant message being continued (tool approvals). */
  continuation: boolean;
  /**
   * A routine's first segment (nobody watching): the instructions note, personal-plan refusal unless allowed, no
   * memory extraction.
   */
  background?: boolean;
  /** Runs in the run executor, which can pause at approvals (passed to resolveModel). */
  interactive?: boolean;
  abortSignal?: AbortSignal;
  /** The durable run executing this turn: recorded on usage events, and handed to providers (resolveModel `run`). */
  run?: RunHandle;
  /** The assistant message id for a new turn (pre-allocated by the run); a continuation keeps the last message's id. */
  responseMessageId?: string;
  /**
   * Replaces persistAssistantTurn (the run executor saves under its lease and closes unfinished parts first). `end`
   * carries the turn's user-facing error text, if the model or a stream processing step failed.
   */
  persist?: (input: PersistTurnInput, end: { error?: string }) => Promise<void>;
};

export type TurnResult = {
  stream: ReadableStream<UIMessageChunk>;
  /** Mutable native checkpoint, available even when closing a tool connection delays done. */
  native?: ResumeState["native"];
  /** Resolves after the response and supplied persistence callback finish; executors may defer saving until event commit. */
  done: Promise<{ responseMessage: PortalUIMessage; pendingApproval: boolean; error?: string; native?: ResumeState["native"] }>;
  /** Who pays for this turn (resolveModel's billing source). */
  billing?: { source: BillingSource };
};

/**
 * Runs one assistant turn (chat app or bot agent loop) and streams UI message chunks. Called by the run executor
 * (src/lib/runs/execute.ts) for every direct chat and routine segment; group chats have their own loop (group.ts).
 */
export async function runTurn(opts: TurnOptions): Promise<TurnResult> {
  const { principal, conversation, app, bot, history } = opts;
  const toolSettings = await getSetting("tools");
  const background = !!opts.background;
  // The assistant message id is fixed up front (by the run for a new turn) so every model call of the turn
  // (including delegates and the title) can be linked to it and to the run in the usage ledger. A continuation
  // extends the last assistant message.
  const responseMessageId = opts.continuation ? history.at(-1)!.id : (opts.responseMessageId ?? newId());
  const usage = newUsageScope({ messageId: responseMessageId, runId: opts.run?.id });
  const delegated = opts.delegation;
  const nativeEligible = app.provider !== "hermes" && !!opts.run?.holder && !!opts.run.deadlineAt && (!delegated || delegated.task.mode === "async");
  const previousNative = opts.run?.resumeState?.native;
  if (nativeEligible && previousNative && previousNative.sessionVersion !== principal.user.sessionVersion)
    throw new HttpError(403, "The account or session changed while this reply was suspended.");
  const native: ResumeState["native"] = nativeEligible ? {
    deadlineAt: Math.min(opts.run!.deadlineAt!, previousNative?.deadlineAt ?? Infinity),
    sessionVersion: principal.user.sessionVersion, stepsUsed: previousNative?.stepsUsed ?? 0, background,
    maxSteps: Math.min(bot ? bot.maxSteps : 1, toolSettings.maxStepsCap, previousNative?.maxSteps ?? Infinity), taskIds: [],
  } : undefined;
  if (native && (native.deadlineAt <= Date.now() || native.stepsUsed >= native.maxSteps))
    throw new HttpError(409, "This reply exhausted its deadline or model-step budget. Start a new request to continue.");
  const ctx: AgentCtx = { principal, conversationId: conversation.id, bot, app, depth: delegated?.task.depth ?? 0, background, toolSettings, usage, nativeSearchMode: conversation.nativeSearchMode,
    ...(opts.run?.holder && opts.run.deadlineAt ? { execution: { holder: opts.run.holder, deadlineAt: opts.run.deadlineAt, segment: opts.run.segment } } : {}),
    ...(native ? { awaitTask: (taskId: string) => { if (!native.taskIds.includes(taskId)) native.taskIds.push(taskId); } } : {}),
    ...(delegated ? { taskId: delegated.task.id, delegationPath: delegated.task.ancestry, inGroup: delegated.parent?.inGroup, workspace: delegated.parent?.workspace,
      relayWorkspaceApproval: nativeEligible && delegated.task.mode === "async" } : {}) };
  const { delegatedAuthorityBinding, DelegationAuthorityChangedError } = await import("@/lib/delegation/authority");
  const authority = delegated ? await delegatedAuthorityBinding(ctx, true) : null;
  const toolset = await buildToolset(ctx);
  const authorizeDispatch = async () => {
    if (!delegated) return;
    await delegated.authorize();
    if (authority !== await delegatedAuthorityBinding(ctx))
      throw new DelegationAuthorityChangedError();
  };
  // Authorize every built-in/MCP/nested call, including calls offered before a revocation.
  if (delegated) for (const t of Object.values(toolset.tools)) {
    const execute = t.execute;
    if (!execute) continue;
    t.execute = (async function* (input, options) {
      await authorizeDispatch();
      const output = execute(input, options);
      if (output && typeof output === "object" && Symbol.asyncIterator in output) {
        for await (const part of output) yield part;
      } else yield await output;
    }) as typeof execute;
  }

  // Everything between opening MCP connections and handing the stream over can throw (attachments, memory,
  // model resolution); close the toolset in that case so MCP clients don't leak.
  const start = async () => {
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    const userText = lastUser ? partsToText(lastUser.parts) : "";
    const memories = !delegated && bot?.executionMode !== "service" && (await memoryEnabled(principal.user.id))
      ? await selectMemories({ userId: principal.user.id, botId: bot?.id ?? null, query: userText, limit: 15, conversationId: conversation.id }).catch(
          () => [],
        )
      : [];

    const coordinator = await getSetting("coordinator");
    const sections = buildInstructionSections({
      coordinator: coordinator.enabled && coordinator.defaultBotId === bot?.id && app.provider !== "hermes",
      app,
      bot,
      userName: principal.user.name,
      customInstructions: delegated || bot?.executionMode === "service" ? undefined : principal.user.prefs?.customInstructions,
      memories,
      skills: toolset.skills,
      delegates: toolset.delegates,
      background,
      delegatedBy: delegated?.task.assignerName,
      workspace: toolset.workspace?.description,
    });
    // "/skill-slug do X" in the composer explicitly invokes a skill.
    const invoked = slashInvokedSkill(toolset.skills, userText);
    if (invoked && !opts.continuation && !delegated) {
      sections.push({
        kind: "dynamic",
        text: `The user explicitly invoked the skill "${invoked.slug}". Call use_skill with slug "${invoked.slug}" first, then follow it.`,
      });
    }

    const withFiles = await resolveAttachmentsForModel(history, app, conversation.userId);
    const { model, capabilities, billing, replayKey } = await resolveModel(app, {
      purpose: delegated ? "delegate" : "chat",
      principal,
      conversationId: conversation.id,
      botId: bot?.id ?? null,
      usage,
      nativeSearch: toolset.nativeSearch,
      background,
      interactive: opts.interactive,
      run: opts.run,
      ...(delegated ? { toolCallId: delegated.task.originToolCallId } : {}),
    });
    // Sealed reasoning is only replayed to the app, model and account that produced it (see replay.ts).
    const modelHistory = scrubForeignOpenAIMetadata(withFiles, { appId: app.id, providerKind: app.provider, model: app.model, replayKey });
    const messages = await convertToModelMessages(modelHistory, { tools: toolset.tools, ignoreIncompleteToolCalls: true });
    const maxSteps = native ? native.maxSteps - native.stepsUsed : bot ? Math.min(bot.maxSteps, toolSettings.maxStepsCap) : 1;
    const result = streamText({
      model,
      instructions: toModelInstructions(sections, capabilities.instructionStyle),
      messages,
      tools: toolset.tools,
      toolApproval: toolset.approval,
      experimental_toolApprovalSecret: toolApprovalSecret(delegated && nativeEligible
        ? `${toolset.approvalBinding ?? ""}:${delegated.task.id}:${opts.run!.id}:${authority}` : toolset.approvalBinding),
      stopWhen: [isStepCount(maxSteps), () => !!native?.taskIds.length],
      ...(native ? { onStepEnd: () => { native.stepsUsed++; } } : {}),
      temperature: app.temperature ?? undefined,
      maxOutputTokens: app.maxTokens ?? undefined,
      timeout: toolset.timeout,
      abortSignal: opts.abortSignal,
      ...(toolset.nativeSearch ? { maxRetries: 0 } : {}),
      ...(delegated ? { maxRetries: 0, prepareStep: async () => { await authorizeDispatch(); return {}; } } : {}),
    });
    return { result, userText, billing, replayKey };
  };
  const { result, userText, billing, replayKey } = await start().catch(async (err) => {
    await toolset.close();
    throw err;
  });

  const isFirstTurn = !delegated && !opts.continuation && history.length === 1 && conversation.title === "New chat";
  let resolveDone!: (v: Awaited<TurnResult["done"]>) => void;
  const done = new Promise<Awaited<TurnResult["done"]>>((r) => (resolveDone = r));
  const parentId = history.at(-1)?.id ?? null;

  // A continuation extends the stored assistant message, and the new turn's identity (app, model, replayKey) is
  // merged into it. Drop sealed reasoning the new identity may not replay from its earlier parts first, so the
  // saved message never pairs one account's reasoning with another account's key.
  const replayTarget = { appId: app.id, providerKind: app.provider, model: app.model, replayKey };
  const originalMessages = opts.continuation ? [...history.slice(0, -1), ...scrubForeignOpenAIMetadata(history.slice(-1), replayTarget)] : history;

  // The first user-facing error text the stream carried (a model error chunk, or a failure while streaming): it
  // fails the turn (done.error), so a routine doesn't report an empty reply as a success. `produced` holds every error
  // text this turn made: the SDK hands each error chunk to createUIMessageStream's onError again (as an Error with the
  // chunk's text), where a known text is recorded as is instead of being wrapped a second time.
  let streamError: string | undefined;
  const produced = new Set<string>();
  const produce = (text: string) => (produced.add(text), text);
  const stream = createUIMessageStream<PortalUIMessage>({
    originalMessages,
    generateId: () => responseMessageId,
    // Sees every error chunk (never tool errors, which are tool output) and failures of the stream itself.
    onError: (err) => {
      if (err instanceof Error && produced.has(err.message)) {
        streamError ??= err.message;
        return err.message;
      }
      if (!(approvalErrorMessage(err) ?? userFacingMessage(err))) console.error("[agent] stream error", err);
      const text = produce(streamErrorText(err));
      streamError ??= text;
      return text;
    },
    execute: async ({ writer }) => {
      for (const w of toolset.warnings) writer.write({ type: "data-notice", data: { message: w }, transient: true });

      const titlePromise = isFirstTurn
        ? (async () => {
            const fallback = userText.slice(0, 60) || "New chat";
            // Background work only runs on company credentials; without an eligible app, use the text itself.
            const tApp = await utilityApp(app);
            const title = tApp
              ? await generateTitle(tApp, userText || "Attachment", {
                  userId: principal.user.id,
                  conversationId: conversation.id,
                  botId: bot?.id ?? null,
                  usage,
                }).catch(() => fallback)
              : fallback;
            await db.update(conversations).set({ title }).where(eq(conversations.id, conversation.id));
            writer.write({ type: "data-title", data: { title }, transient: true });
          })()
        : Promise.resolve();

      writer.merge(
        toUIMessageStream<typeof toolset.tools, PortalUIMessage>({
          stream: result.stream,
          tools: toolset.tools,
          sendReasoning: true,
          sendSources: true,
          // Actionable messages (connect or reconnect a ChatGPT plan, limit reached) are shown as is; anything else
          // stays generic so provider error bodies never reach the browser. This also words tool errors (shown on the
          // tool's card), so the text is recorded as the turn's error only when it arrives as an error chunk (above).
          onError: (err) => {
            const actionable = approvalErrorMessage(err) ?? userFacingMessage(err);
            if (!actionable) console.error("[agent] model or tool error", err);
            return produce(actionable ?? "An error occurred.");
          },
          messageMetadata: ({ part }) => {
            if (part.type === "start")
              // A continuation (after an approval) keeps the turn's original start, so "Worked for" covers the whole turn.
              return { createdAt: Date.now(), startedAt: (opts.continuation && history.at(-1)?.metadata?.startedAt) || Date.now(), model: app.model, botId: bot?.id, appId: app.id, providerKind: app.provider, ...(replayKey ? { replayKey } : {}) };
            if (part.type === "finish")
              return { inputTokens: part.totalUsage.inputTokens, outputTokens: part.totalUsage.outputTokens, finishedAt: Date.now() };
            return undefined;
          },
        }),
      );
      await titlePromise;
    },
    onEnd: async ({ responseMessage, isContinuation, outcome }) => {
      const meta = responseMessage.metadata ?? {};
      const error = outcome.status === "failed" ? streamErrorText(outcome.error) : streamError;
      const input: PersistTurnInput = {
        conversationId: conversation.id,
        userId: principal.user.id,
        botId: bot?.id ?? null,
        responseMessage,
        isContinuation,
        parentId,
        extra: {
          model: app.model,
          inputTokens: meta.inputTokens ?? null,
          outputTokens: meta.outputTokens ?? null,
          billingSource: billing.source,
          providerKind: app.provider,
          appId: app.id,
        },
        background: background || !!delegated,
        runId: opts.run?.id,
      };
      try {
        if (opts.persist) await opts.persist(input, { error });
        else await persistAssistantTurn(input);
      } catch (err) {
        console.error("[agent] failed to persist response", err);
      } finally {
        await toolset.close();
        await Promise.allSettled(usage.pending);
        resolveDone({ responseMessage, pendingApproval: hasPendingApproval(responseMessage), error, native });
      }
    },
  });

  // Keep generating (and persist) even if the consumer stops reading mid-stream.
  void result.consumeStream();
  return { stream, done, native, billing: { source: billing.source } };
}

/** What people see for an error that ends or interrupts a turn: actionable messages as is, anything else redacted. */
function streamErrorText(err: unknown): string {
  const actionable = approvalErrorMessage(err) ?? userFacingMessage(err);
  if (actionable) return actionable;
  return err instanceof Error ? `The model endpoint returned an error: ${redactSecrets(err.message)}` : "Something went wrong.";
}

function approvalErrorMessage(err: unknown) {
  return InvalidToolApprovalSignatureError.isInstance(err)
    ? "Tool permissions or configuration changed. Start a new request and review its new approval card."
    : undefined;
}
