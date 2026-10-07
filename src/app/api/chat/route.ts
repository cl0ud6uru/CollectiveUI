import { nativeSearchSelection } from "@/lib/agent/native-search";
import { isDockerHermes } from "@/lib/docker-hermes/policy";
import { authorizeDockerStream } from "@/lib/docker-hermes/store";
import { createUIMessageStreamResponse } from "ai";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { conversations, messages, type Conversation, type Message } from "@/db/schema";
import { decisionsFromClientParts } from "@/lib/agent/approval-merge";
import { loadGroupMembers, runGroupTurn } from "@/lib/agent/group";
import { resolveTurnTarget } from "@/lib/agent/target";
import type { Principal } from "@/lib/auth/groups";
import { getAccessibleModel, getUsableBot, HttpError } from "@/lib/authz";
import { insertMessage, loadMessageRows, pathTo, rowToUIMessage, setCurrentLeaf, type PortalUIMessage } from "@/lib/chat/store";
import { CLIENT_ID_RE } from "@/lib/ids";
import { sseResponse } from "@/lib/runs/sse";
import { RunBusyError, runOfMessage } from "@/lib/runs/state";
import { continueRun, startRun, waitForRunEnd } from "@/lib/runs/store";
import { tailRun } from "@/lib/runs/tail";
import { isActive, type AgentRun } from "@/lib/runs/types";
import { errorResponse, requirePrincipal } from "@/lib/session";
import { getSetting } from "@/lib/settings";
import { parseHermesInput } from "@/lib/chat/hermes-commands";
import { isTeamRuntimeApp } from '@/lib/agent/team-target';
import { authorizeTeamConversation } from '@/lib/hermes-team/conversations';

// No maxDuration: direct chats run in the worker and this response only tails the run's event log, which may stay
// open for as long as the reply takes (self-hosted Node has no route time limit; a proxy must allow long reads).

const FilePart = z.object({
  type: z.literal("file"),
  mediaType: z.string().max(200),
  filename: z.string().max(300).optional(),
  url: z.string().regex(/^\/api\/files\/[A-Za-z0-9]+$/),
});
const TextPart = z.object({ type: z.literal("text"), text: z.string().max(200_000) });

const Body = z.object({
  conversationId: z.string().regex(CLIENT_ID_RE),
  appId: z.string().optional(),
  botId: z.string().optional(),
  parentId: z.string().nullable().optional(),
  nativeSearchMode: z.enum(["off", "auto"]).nullable().optional(),
  regenerate: z.boolean().optional(),
  literalSlash: z.boolean().optional(),
  message: z
    .object({
      id: z.string().regex(CLIENT_ID_RE),
      role: z.enum(["user", "assistant"]),
      parts: z.array(z.any()).max(50),
    })
    .optional(),
});
type Body = z.infer<typeof Body>;

/** The new user message from the request (text and uploaded files only). */
async function userMessageOf(message: NonNullable<Body["message"]>): Promise<PortalUIMessage> {
  const parts = z.array(z.union([TextPart, FilePart])).min(1).parse(message.parts);
  const { maxAttachmentsPerMessage } = await getSetting("limits");
  if (parts.filter((x) => x.type === "file").length > maxAttachmentsPerMessage)
    throw new HttpError(400, `At most ${maxAttachmentsPerMessage} attachments per message`);
  return { id: message.id, role: "user", parts, metadata: { createdAt: Date.now() } };
}

/** Waits briefly for a parent that isn't saved yet (a stopped reply still being persisted). */
async function waitForRow(conversationId: string, id: string, rows: Message[]): Promise<Message[]> {
  for (let i = 0; i < 10 && !rows.some((r) => r.id === id); i++) {
    await new Promise((r) => setTimeout(r, 300));
    rows = await loadMessageRows(conversationId);
  }
  return rows;
}

/**
 * The parent of a new user message in a direct chat. A reply the user stopped ("Stop and send") is saved when its run
 * ends, so wait for that; a run stopped before any part was saved has no row, and the question it answered becomes
 * the parent instead.
 */
async function resolveParent(conversationId: string, parentId: string | null, rows: Message[]): Promise<string | null> {
  if (!parentId || rows.some((r) => r.id === parentId)) return parentId;
  const prior = await runOfMessage(parentId);
  if (!prior || prior.conversationId !== conversationId) {
    rows = await waitForRow(conversationId, parentId, rows);
    if (!rows.some((r) => r.id === parentId)) throw new HttpError(400, "Unknown parent message");
    return parentId;
  }
  const state = isActive(prior.status) && prior.cancelRequestedAt ? await waitForRunEnd(prior.id) : prior;
  if (state && isActive(state.status)) throw new RunBusyError();
  rows = await loadMessageRows(conversationId);
  return rows.some((r) => r.id === parentId) ? parentId : prior.parentMessageId;
}

/** Group chats still run in the request (not on durable runs): the request's abort ends the turn. */
async function groupTurn(req: Request, p: Principal, conv: Conversation, body: Body): Promise<Response> {
  const members = await loadGroupMembers(p, conv.id);
  if (!members.length) throw new HttpError(400, "None of this group's bots are available to you");
  let rows = await loadMessageRows(conv.id);
  // If the user hit "stop" and immediately sent again, the partial reply may still be persisting.
  if (body.parentId) rows = await waitForRow(conv.id, body.parentId, rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  let history: PortalUIMessage[];
  if (body.message?.role === "user") {
    const parentId = body.parentId ?? null;
    if (parentId && !byId.has(parentId)) throw new HttpError(400, "Unknown parent message");
    if (byId.has(body.message.id)) throw new HttpError(409, "Duplicate message id");
    const userMsg = await userMessageOf(body.message);
    await insertMessage(conv.id, userMsg, parentId);
    await setCurrentLeaf(conv.id, userMsg.id);
    history = [...pathTo(rows, parentId).map(rowToUIMessage), userMsg];
  } else if (body.regenerate && body.parentId) {
    const parent = byId.get(body.parentId);
    if (!parent || parent.role !== "user") throw new HttpError(400, "Can only regenerate a reply to a user message");
    history = pathTo(rows, parent.id).map(rowToUIMessage);
  } else {
    throw new HttpError(400, "Nothing to do");
  }
  return createUIMessageStreamResponse({
    stream: await runGroupTurn({ principal: p, conversation: conv, members, history, abortSignal: req.signal }),
  });
}

export async function POST(req: Request) {
  let body: Body | undefined;
  try {
    const p = await requirePrincipal();
    body = Body.parse(await req.json());
    const input = body;

    // Load or create the conversation (ids are generated client-side, like ChatGPT's URL-on-first-send).
    let [conv] = await db.select().from(conversations).where(eq(conversations.id, body.conversationId));
    if (conv && conv.userId !== p.user.id) throw new HttpError(404, "Conversation not found");
    if (!conv) {
      if (!body.message || body.message.role !== "user") throw new HttpError(400, "Conversation not found");
      if (body.botId) await getUsableBot(p, body.botId);
      else if (body.appId) await getAccessibleModel(p, body.appId);
      else throw new HttpError(400, "Choose a model or bot to chat with");
      if (body.nativeSearchMode === "auto") {
        const { app, bot } = await resolveTurnTarget(p, { appId: body.appId ?? null, botId: body.botId ?? null });
        const { reason } = await nativeSearchSelection(app, bot, await getSetting("tools"), "auto");
        if (reason) throw new HttpError(403, reason);
      }
      [conv] = await db
        .insert(conversations)
        .values({
          id: body.conversationId,
          userId: p.user.id,
          appId: body.botId ? null : body.appId,
          botId: body.botId ?? null,
          nativeSearchMode: body.nativeSearchMode ?? null,
        })
        .onConflictDoNothing()
        .returning();
      if (!conv) throw new HttpError(409, "Conversation id already in use");
    }

    if (conv.source === "delegation") throw new HttpError(409, "Delegated tasks are read-only. Start a separate chat to follow up.");
    if (conv.isGroup) return await groupTurn(req, p, conv, body);

    // Direct chats are durable runs: the worker executes the turn; this response tails its event log. The run
    // outlives the request (closing the tab doesn't stop it; Stop is POST /api/chat/[id]/stop).
    const { bot, app } = await resolveTurnTarget(p, conv);
    const rows = await loadMessageRows(conv.id);
    let run: AgentRun;
    let continuation = false;
    if (body.message?.role === "user") {
      if (rows.some((r) => r.id === input.message!.id)) throw new HttpError(409, "Duplicate message id");
      const userMessage = await userMessageOf(body.message);
      if (app.provider === "hermes" && !body.literalSlash) {
        const text = userMessage.parts.map((part) => part.type === "text" ? part.text : "").join("\n");
        const input = parseHermesInput(text);
        if (input.kind === "command") throw new HttpError(400, "Use the command menu for Hermes slash controls, or // to send literal slash text. No model reply was started.");
        if (input.literal) userMessage.parts = [...userMessage.parts.filter((part) => part.type !== "text"), { type: "text", text: input.text }];
      }
      const parentId = await resolveParent(conv.id, body.parentId ?? null, rows);
      run = await startRun({ principal: p, conversation: conv, bot, app, userMessage, parentId });
    } else if (body.message?.role === "assistant") {
      // Approval answers: only {approved, reason} per approval id are taken from the client.
      run = await continueRun({ principal: p, conversation: conv, messageId: body.message.id, decisions: decisionsFromClientParts(body.message.parts) });
      continuation = true;
    } else if (body.regenerate && body.parentId) {
      const parent = rows.find((r) => r.id === input.parentId);
      if (!parent || parent.role !== "user") throw new HttpError(400, "Can only regenerate a reply to a user message");
      run = await startRun({ principal: p, conversation: conv, bot, app, parentId: parent.id });
    } else {
      throw new HttpError(400, "Nothing to do");
    }
    // A continuation's browser already has the message so far: tail from the segment boundary.
    return sseResponse(tailRun(run.id, { afterSeq: continuation ? run.boundarySeq : 0, targetSegment: run.segment, replay: false,
      authorize: isTeamRuntimeApp(app) ? async () => { await authorizeTeamConversation(p, conv.id); }
        : isDockerHermes(app) && bot ? () => authorizeDockerStream(p, bot.id) : undefined }));
  } catch (err) {
    if (err instanceof HttpError || err instanceof z.ZodError) {
      const status = err instanceof HttpError ? err.status : 400;
      const error = err instanceof HttpError ? err.message : "Invalid request";
      // Regeneration references an already-persisted prompt. Only return an exact draft identity that is absent
      // from storage; queue failures and duplicate IDs must never roll back a saved user message.
      if (!body?.regenerate && body?.message?.role === "user") {
        try {
          const [saved] = await db.select({ id: messages.id }).from(messages).where(eq(messages.id, body.message.id)).limit(1);
          if (!saved) return Response.json({ error, unsavedMessageId: body.message.id }, { status });
        } catch { /* Database uncertainty: retain the message until the user reloads. */ }
      }
      if (!body?.regenerate && body?.message?.role === "assistant" && [400, 404, 409, 429].includes(status))
        return Response.json({ error, retryApprovalMessageId: body.message.id }, { status });
      return Response.json({ error }, { status });
    }
    return errorResponse(err);
  }
}
