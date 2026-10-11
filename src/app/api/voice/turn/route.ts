import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { messages } from "@/db/schema";
import { HttpError } from "@/lib/authz";
import { requirePrincipal, errorResponse } from "@/lib/session";
import { CLIENT_ID_RE } from "@/lib/ids";
import { partsToText } from "@/lib/chat/store";
import { runOfMessage } from "@/lib/runs/state";
import { assertSameOrigin, readBoundedJson } from "@/lib/voice/http";
import { targetFor } from "@/lib/voice/target";
import { commitVoiceBatch } from "@/lib/voice/turn";

const Batch = z.object({
  conversationId: z.string().regex(CLIENT_ID_RE), batchId: z.string().regex(CLIENT_ID_RE), sessionId: z.string().min(1).max(200),
  delegate: z.boolean(), fragments: z.array(z.object({ id: z.string().min(1).max(200), role: z.enum(["user", "assistant"]),
    text: z.string().min(1).max(12000), startMs: z.number().finite().nonnegative(), endMs: z.number().finite().nonnegative(),
  }).strict().refine(f => f.endMs >= f.startMs)).min(1).max(200),
}).strict();

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const p = await requirePrincipal();
    const input = Batch.parse(await readBoundedJson(req));
    return Response.json(await commitVoiceBatch(p, input), { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function GET(req: Request) {
  try {
    const p = await requirePrincipal();
    const query = new URL(req.url).searchParams;
    const conversationId = z.string().regex(CLIENT_ID_RE).parse(query.get("conversationId"));
    const messageId = z.string().regex(CLIENT_ID_RE).parse(query.get("messageId"));
    await targetFor(p, { conversationId });
    const run = await runOfMessage(messageId);
    if (!run || run.conversationId !== conversationId || run.userId !== p.user.id) throw new HttpError(404, "Voice request not found.");
    const [message] = await db.select().from(messages).where(eq(messages.id, messageId));
    return Response.json({ status: run.status, text: message ? partsToText(message.parts) : "" }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
