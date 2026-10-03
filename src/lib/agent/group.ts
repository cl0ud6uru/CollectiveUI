import { runConfig } from "@/lib/runs/types";
import { runHost } from "@/lib/runs/host";
import { receiveGroupResults } from "@/lib/delegation/receipts";
import { sha256Hex } from "@/lib/crypto";
import {
  createUIMessageStream,
  getToolOrDynamicToolName,
  isStepCount,
  isToolUIPart,
  streamText,
  toUIMessageStream,
  type ModelMessage,
  type UserModelMessage,
} from "ai";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiApps, conversationBots, conversations, toolCalls, type AiApp, type Bot, type Conversation } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { HttpError, getAccessibleBot } from "@/lib/authz";
import { insertMessage, partsToText, setCurrentLeaf, type PortalUIMessage } from "@/lib/chat/store";
import { toolApprovalSecret } from "@/lib/crypto";
import { newId } from "@/lib/ids";
import { redactSecrets } from "@/lib/redact";
import { newUsageScope, resolveModel, userFacingMessage } from "@/lib/llm";
import { userMayUseChatGPT } from "@/lib/llm/chatgpt/policy";
import { getSetting } from "@/lib/settings";
import { buildInstructionSections, toModelInstructions } from "./instructions";
import { memoryEnabled, selectMemories } from "./memory";
import { resolveMentions } from "./mentions";
import { resolveAttachmentsForModel } from "./prepare";
import { toolStatus } from "./persist";
import { buildToolset } from "./toolset";

/** Max bot replies per user message, so handoffs can't loop forever. */
export const MAX_GROUP_REPLIES = 6;

export type GroupMember = { bot: Bot; app: AiApp };
export type SpeakerData = { botId: string; name: string; avatar: string | null };
/** A bot in a group chat couldn't answer (saved with the message, shown under the bot, never sent to models). */
export type BotErrorData = { botId: string; message: string };

export async function loadGroupMembers(principal: Principal, conversationId: string): Promise<GroupMember[]> {
  const rows = await db
    .select({ botId: conversationBots.botId })
    .from(conversationBots)
    .where(eq(conversationBots.conversationId, conversationId))
    .orderBy(asc(conversationBots.position));
  const members: GroupMember[] = [];
  let plansAllowed: boolean | undefined;
  for (const r of rows) {
    const bot = await getAccessibleBot(principal, r.botId).catch(() => null);
    if (bot?.executionMode === "service") throw new HttpError(403, "Service bots can only run in direct chats, not group chats.");
    if (!bot?.enabled || !bot.appId) continue;
    const [app] = await db.select().from(aiApps).where(eq(aiApps.id, bot.appId));
    if (!app?.enabled) continue;
    // Bots on a ChatGPT plan app only take part for people allowed to use their own plan.
    if (app.provider === "chatgpt") {
      plansAllowed ??= userMayUseChatGPT(principal, await getSetting("chatgpt"));
      if (!plansAllowed) continue;
    }
    members.push({ bot, app });
  }
  return members;
}

/**
 * Preserve resolved user images and flatten bot replies into labelled turns for one bot. Other bots' replies are labelled
 * with their names so each model knows who said what.
 */
export function groupTranscript(history: PortalUIMessage[], selfId: string): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of history) {
    if (m.role === "user") {
      const content: Exclude<UserModelMessage["content"], string> = [];
      for (const p of m.parts) {
        if (p.type === "text") content.push({ type: "text", text: p.text });
        // Only the resolver's inline images: never pass browser file routes or remote URLs to a provider.
        else if (p.type === "file" && p.mediaType.startsWith("image/") && p.url.startsWith(`data:${p.mediaType};base64,`))
          content.push({ type: "file", data: p.url, mediaType: p.mediaType });
      }
      const hasImage = content.some(p => p.type === "file");
      out.push({ role: "user", content: hasImage ? content : partsToText(m.parts) || "(attachment)" });
      continue;
    }
    let speaker: SpeakerData | null = null;
    const segments: { speaker: SpeakerData | null; text: string }[] = [];
    for (const p of m.parts) {
      if (p.type === "data-speaker") {
        speaker = p.data as SpeakerData;
        segments.push({ speaker, text: "" });
      } else if (p.type === "text") {
        if (!segments.length) segments.push({ speaker, text: "" });
        segments[segments.length - 1].text += p.text;
      }
    }
    for (const s of segments) {
      if (!s.text.trim()) continue;
      if (s.speaker?.botId === selfId) out.push({ role: "assistant", content: s.text });
      else out.push({ role: "user", content: `[${s.speaker?.name ?? "Teammate"}]: ${s.text}` });
    }
  }
  return mergeTurns(out);
}

/** Providers expect alternating turns: merge consecutive same-role text messages. */
export function mergeTurns(messages: ModelMessage[]): ModelMessage[] {
  const merged: ModelMessage[] = [];
  for (const m of messages) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role && typeof prev.content === "string" && typeof m.content === "string") {
      prev.content = `${prev.content}\n\n${m.content}`;
    } else if (prev?.role === "user" && m.role === "user") {
      const parts = (content: UserModelMessage["content"]) => typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
      prev.content = [...parts(prev.content), { type: "text", text: "\n\n" }, ...parts(m.content)];
    } else merged.push({ ...m } as ModelMessage);
  }
  return merged;
}

/** Decide who answers a user message: mentioned bots in order, else the lead (first member). */
export function initialQueue(userText: string, members: { id: string; name: string }[]): string[] {
  const mentioned = resolveMentions(userText, members);
  return mentioned.length ? mentioned : members.length ? [members[0].id] : [];
}

export async function runGroupTurn(opts: {
  principal: Principal;
  conversation: Conversation;
  members: GroupMember[];
  history: PortalUIMessage[];
  abortSignal?: AbortSignal;
}) {
  const { principal, conversation, members, history } = opts;
  const toolSettings = await getSetting("tools");
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  const userText = lastUser ? partsToText(lastUser.parts) : "";
  const roster = members.map((m) => ({ id: m.bot.id, name: m.bot.name }));
  const parentId = history.at(-1)?.id ?? null;
  const useMemory = await memoryEnabled(principal.user.id);
  const messageId = newId();
  const usageScope = newUsageScope({ messageId });
  const execution = { holder: runHost().instanceId, deadlineAt: Date.now() + runConfig().runTimeoutMs };

  return createUIMessageStream<PortalUIMessage>({
    originalMessages: history,
    generateId: newId,
    onError: (err) =>
      userFacingMessage(err) ?? (err instanceof Error ? `A bot hit an error: ${redactSecrets(err.message)}` : "Something went wrong."),
    execute: async ({ writer }) => {
      writer.write({ type: "start", messageId, messageMetadata: { createdAt: Date.now(), startedAt: Date.now(), model: "group" } });
      const queue = initialQueue(userText, roster);
      const spoken: { id: string; name: string; text: string }[] = [];
      // Bots that couldn't answer aren't asked again in the same turn (e.g. when a teammate @mentions them).
      const failedBots = new Set<string>();
      let inputTokens = 0;
      let outputTokens = 0;

      while (queue.length && spoken.length < MAX_GROUP_REPLIES) {
        // Stop pressed (or the client went away): don't start the next bot.
        if (opts.abortSignal?.aborted) break;
        const botId = queue.shift()!;
        const member = members.find((m) => m.bot.id === botId);
        if (!member) continue;
        const { bot, app } = member;
        writer.write({ type: "data-speaker", data: { botId: bot.id, name: bot.name, avatar: bot.avatar } satisfies SpeakerData });

        const toolCallPrefix = `${newId()}:`;
        const ctx = { principal, conversationId: conversation.id, bot, app, depth: 0, background: false, inGroup: true, toolSettings, usage: usageScope, execution, toolCallPrefix };
        const toolset = await buildToolset(ctx);
        try {
          const memories = useMemory
            ? await selectMemories({ userId: principal.user.id, botId: bot.id, query: userText, limit: 10, conversationId: conversation.id }).catch(
                () => [],
              )
            : [];
          const others = members.filter((m) => m.bot.id !== bot.id);
          const sections = buildInstructionSections({
            app,
            bot,
            userName: principal.user.name,
            customInstructions: principal.user.prefs?.customInstructions,
            memories,
            skills: toolset.skills,
            delegates: [],
            background: false,
            workspace: toolset.workspace?.description,
          });
          sections.push({
            kind: "stable",
            text: `## Group chat\nYou are in a group chat with the user and these teammates:\n${others
              .map((o) => `- @${o.bot.name}${o.bot.label ? ` (${o.bot.label})` : ""}: ${o.bot.description ?? ""}`)
              .join("\n")}\nTeammates' messages are prefixed with their name. Reply only to the part that is yours. To hand work to a teammate, @mention them by name in your reply and say exactly what you need; don't mention anyone otherwise. Never write another teammate's reply for them.`,
          });

          const visible = await resolveAttachmentsForModel(history, app, conversation.userId);
          const messages = groupTranscript(visible, bot.id);
          const handoff = spoken.filter((s) => s.id !== bot.id);
          if (handoff.length) {
            messages.push({
              role: "user",
              content: handoff.map((s) => `[${s.name}]: ${s.text}`).join("\n\n") + `\n\nIt's your turn, @${bot.name}.`,
            });
          }

          const { model, capabilities } = await resolveModel(app, {
            purpose: "group",
            principal,
            conversationId: conversation.id,
            botId: bot.id,
            usage: usageScope,
          });
          const result = streamText({
            model,
            instructions: toModelInstructions(sections, capabilities.instructionStyle),
            messages: endWithUser(mergeTurns(messages)),
            tools: toolset.tools,
            toolApproval: toolset.approval,
            experimental_toolApprovalSecret: toolApprovalSecret(),
            stopWhen: isStepCount(Math.min(bot.maxSteps, toolSettings.maxStepsCap)),
            temperature: app.temperature ?? undefined,
            maxOutputTokens: app.maxTokens ?? undefined,
            timeout: toolset.timeout,
            abortSignal: opts.abortSignal,
          });
          // Pipe chunks in order so each bot's reply stays grouped under its speaker marker.
          const reader = toUIMessageStream({
            stream: result.stream,
            tools: toolset.tools,
            sendStart: false,
            sendFinish: false,
            onError: (err) => userFacingMessage(err) ?? "An error occurred.",
          }).getReader();
          let failed: string | undefined;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            // A model failure ends only this bot's reply, not the whole group message.
            if (value.type === "error") {
              failed = value.errorText;
              continue;
            }
            // Provider call ids are only unique within one speaker invocation.
            writer.write(("toolCallId" in value ? { ...value, toolCallId: `${toolCallPrefix}${value.toolCallId}` } : value) as never);
          }
          if (failed) throw new BotReplyError(failed);
          const finalStep = await result.finalStep;
          const text = finalStep.text ?? "";
          const usage = await result.usage;
          inputTokens += usage.inputTokens ?? 0;
          outputTokens += usage.outputTokens ?? 0;
          spoken.push({ id: bot.id, name: bot.name, text });

          // Visible handoffs: @mentions of other members queue them next.
          for (const id of resolveMentions(text, roster)) {
            if (id === bot.id || queue.includes(id) || failedBots.has(id)) continue;
            if (spoken.filter((s) => s.id === id).length >= 2) continue;
            queue.push(id);
          }
        } catch (err) {
          // Stopping isn't a bot failure: end the turn.
          if (opts.abortSignal?.aborted) break;
          // e.g. a ChatGPT plan that isn't connected or hit its limit: say so under this bot and let the others go on.
          // It's a separate part (not the bot's text), so it's never replayed to models as something the bot said.
          const message = err instanceof BotReplyError ? err.message : (userFacingMessage(err) ?? "An error occurred.");
          if (!(err instanceof BotReplyError) && !userFacingMessage(err)) console.warn(`[group] ${bot.name} couldn't answer`, err);
          writer.write({ type: "data-bot-error", data: { botId: bot.id, message } satisfies BotErrorData });
          failedBots.add(bot.id);
        } finally {
          await toolset.close();
        }
      }
      writer.write({ type: "finish", messageMetadata: { inputTokens, outputTokens, finishedAt: Date.now() } });
    },
    onEnd: async ({ responseMessage }) => {
      try {
        await Promise.allSettled(usageScope.pending);
        if (!responseMessage.parts.length) return;
        await db.transaction(async tx => {
        await receiveGroupResults(tx, principal.user.id, conversation.id, responseMessage);
        await insertMessage(conversation.id, responseMessage, parentId, {
          model: "group",
          inputTokens: responseMessage.metadata?.inputTokens ?? null,
          outputTokens: responseMessage.metadata?.outputTokens ?? null,
          // Several bots (possibly on different apps and plans) answer in one group message, so no single app/provider;
          // who paid for each call is in usage_events. A non-null value marks the row as ledger-era (src/lib/usage.ts).
          billingSource: "org",
        }, tx);
        await setCurrentLeaf(conversation.id, responseMessage.id, {}, tx);
        await tx.update(conversations).set({ updatedAt: sql`now()` }).where(eq(conversations.id, conversation.id));
        // Audit tool calls, attributed to the bot that was speaking.
        let speaker: string | null = null;
        for (const p of responseMessage.parts) {
          if (p.type === "data-speaker") speaker = (p.data as SpeakerData).botId;
          if (!isToolUIPart(p)) continue;
          let status = toolStatus(p.state, "preliminary" in p && p.preliminary === true);
          if (!status) continue;
          if (status === "done" && "output" in p && p.output && typeof p.output === "object" && "status" in p.output && ["error", "cancelled", "interrupted"].includes(String(p.output.status))) status = "error";
          await tx
            .insert(toolCalls)
            .values({
              id: `call_${sha256Hex(`${responseMessage.id}:${p.toolCallId}`)}`,
              providerCallId: p.toolCallId,
              conversationId: conversation.id,
              messageId: responseMessage.id,
              userId: principal.user.id,
              botId: speaker,
              toolName: getToolOrDynamicToolName(p),
              input: (p.input ?? null) as object | null,
              output: ("output" in p ? p.output : null) as object | null,
              status,
            })
            .onConflictDoNothing();
        }
        });
      } catch (err) {
        console.error("[group] failed to persist", err);
      }
    },
  });
}

/** One bot's reply failed (the message is already safe to show: actionable or generic). */
class BotReplyError extends Error {}

function endWithUser(messages: ModelMessage[]): ModelMessage[] {
  return messages.at(-1)?.role === "user" ? messages : [...messages, { role: "user", content: "(continue)" }];
}
