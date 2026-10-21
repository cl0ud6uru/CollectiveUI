import { z } from "zod";
import { HttpError } from "@/lib/authz";
import { targetFor } from "@/lib/voice/target";
import { assertSameOrigin, readBoundedJson } from "@/lib/voice/http";
import { createVoiceSession, voiceEligibility } from "@/lib/voice/session";
import { configureVoiceTarget } from "@/lib/voice/configuration";
import { prepareVoiceConversation } from "@/lib/voice/conversation";
import { getSetting } from "@/lib/settings";
import { CLIENT_ID_RE } from "@/lib/ids";
import { allowVoiceRequest } from "@/lib/auth/throttle";
import { errorResponse, requirePrincipal } from "@/lib/session";

const TargetShape = z.object({
  appId: z.string().min(1).max(200).optional(),
  botId: z.string().min(1).max(200).optional(),
  conversationId: z.string().min(1).max(200).optional(),
}).strict();
const TargetInput = TargetShape.refine((v) => !!v.conversationId || (!!v.appId !== !!v.botId), "Choose one app or bot target.");
const PostInput = TargetShape.extend({ chatId: z.string().regex(CLIENT_ID_RE), sdp: z.string().min(1).max(60_000), reactionTest: z.literal(true).optional() }).refine((v) => !!v.conversationId || (!!v.appId !== !!v.botId), "Choose one app or bot target.");


export async function GET(req: Request) {
  try {
    const p = await requirePrincipal();
    const query = new URL(req.url).searchParams;
    const parsed = TargetInput.safeParse({ appId: query.get("appId") ?? undefined, botId: query.get("botId") ?? undefined, conversationId: query.get("conversationId") ?? undefined });
    if (!parsed.success) throw new HttpError(400, "Choose one app or bot target.");
    const target = await configureVoiceTarget(p, await targetFor(p, parsed.data));
    return Response.json(await voiceEligibility(target), { headers: { "cache-control": "no-store" } });
  } catch (err) { return errorResponse(err); }
}

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const p = await requirePrincipal();
    const parsed = PostInput.safeParse(await readBoundedJson(req));
    if (!parsed.success) throw new HttpError(400, "Invalid voice session request.");
    if (!await allowVoiceRequest(p.user.id, "session")) throw new HttpError(429, "Too many voice starts. Try again in a minute.");
    const { sdp, chatId, reactionTest, ...targetInput } = parsed.data;
    if (reactionTest && !targetInput.conversationId) throw new HttpError(400, "Choose an existing chat for the reaction test.");
    const target = await configureVoiceTarget(p, await targetFor(p, targetInput));
    const eligibility = await voiceEligibility(target);
    if (!eligibility.supported) throw new HttpError(403, eligibility.reason);
    const { context, history } = reactionTest ? { context: "", history: [] } : await prepareVoiceConversation(p, target, chatId, targetInput.conversationId);
    const settings = await getSetting("voice");
    if (reactionTest && !settings.reactions) throw new HttpError(403, "Enable avatar Decisions in Voice & avatar before testing live reactions.");
    const result = await createVoiceSession(target, sdp, undefined, history, { reactionTest, signal: req.signal,
      userId: p.user.id, conversationId: targetInput.conversationId ?? chatId });
    return Response.json({ session: { id: result.sessionId }, transport: { type: "webrtc", sdp: result.sdp }, context, history,
      avatarUrl: settings.avatarUrl, reactions: settings.reactions }, { headers: { "cache-control": "no-store" } });
  } catch (err) { return errorResponse(err); }
}
