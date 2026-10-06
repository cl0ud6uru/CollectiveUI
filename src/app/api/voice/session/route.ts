import { z } from "zod";
import { getOwnedConversation, HttpError } from "@/lib/authz";
import { resolveTurnTarget } from "@/lib/agent/target";
import { createVoiceSession, voiceEligibility, type VoiceTarget } from "@/lib/voice/session";
import { errorResponse, requirePrincipal } from "@/lib/session";

const TargetShape = z.object({
  appId: z.string().min(1).max(200).optional(),
  botId: z.string().min(1).max(200).optional(),
  conversationId: z.string().min(1).max(200).optional(),
}).strict();
const TargetInput = TargetShape.refine((v) => !!v.conversationId || (!!v.appId !== !!v.botId), "Choose one app or bot target.");
const PostInput = TargetShape.extend({ sdp: z.string().min(1).max(60_000) }).refine((v) => !!v.conversationId || (!!v.appId !== !!v.botId), "Choose one app or bot target.");
const MAX_BODY_BYTES = 64_000;

function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return;
  try {
    if (new URL(origin).origin !== new URL(req.url).origin) throw new HttpError(403, "Cross-origin request denied.");
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(403, "Invalid request origin.");
  }
}

async function readBoundedJson(req: Request): Promise<unknown> {
  const length = Number(req.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new HttpError(413, "Voice request is too large.");
  if (!req.body) throw new HttpError(400, "Invalid JSON request.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "Voice request is too large.");
    }
    chunks.push(value);
  }
  const raw = new TextDecoder().decode(Buffer.concat(chunks));
  try { return JSON.parse(raw); } catch { throw new HttpError(400, "Invalid JSON request."); }
}

async function targetFor(p: Awaited<ReturnType<typeof requirePrincipal>>, input: z.infer<typeof TargetInput>): Promise<VoiceTarget> {
  let ref: { appId: string | null; botId: string | null };
  if (input.conversationId) {
    const conversation = await getOwnedConversation(p, input.conversationId);
    if (conversation.source === "delegation") throw new HttpError(403, "Delegated conversations are read-only.");
    if (conversation.isGroup) throw new HttpError(400, "Voice sessions are not available in group chats.");
    if ((input.appId && input.appId !== conversation.appId) || (input.botId && input.botId !== conversation.botId))
      throw new HttpError(400, "Voice target does not match this conversation.");
    ref = { appId: conversation.appId, botId: conversation.botId };
  } else {
    ref = { appId: input.appId ?? null, botId: input.botId ?? null };
  }
  return resolveTurnTarget(p, ref);
}

export async function GET(req: Request) {
  try {
    const p = await requirePrincipal();
    const query = new URL(req.url).searchParams;
    const parsed = TargetInput.safeParse({ appId: query.get("appId") ?? undefined, botId: query.get("botId") ?? undefined, conversationId: query.get("conversationId") ?? undefined });
    if (!parsed.success) throw new HttpError(400, "Choose one app or bot target.");
    const target = await targetFor(p, parsed.data);
    return Response.json(await voiceEligibility(target), { headers: { "cache-control": "no-store" } });
  } catch (err) { return errorResponse(err); }
}

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const p = await requirePrincipal();
    const parsed = PostInput.safeParse(await readBoundedJson(req));
    if (!parsed.success) throw new HttpError(400, "Invalid voice session request.");
    const { sdp, ...targetInput } = parsed.data;
    const target = await targetFor(p, targetInput);
    const eligibility = await voiceEligibility(target);
    if (!eligibility.supported) throw new HttpError(403, eligibility.reason);
    const result = await createVoiceSession(target, sdp);
    return Response.json({ session: { id: result.sessionId }, transport: { type: "webrtc", sdp: result.sdp } }, { headers: { "cache-control": "no-store" } });
  } catch (err) { return errorResponse(err); }
}
