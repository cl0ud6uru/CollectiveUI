import { z } from "zod";
import { requirePrincipal, errorResponse } from "@/lib/session";
import { getSetting } from "@/lib/settings";
import { providerContextFor } from "@/lib/llm/resolve";
import { requestDecision } from "@/lib/llm/providers/decisions";
import { configureVoiceTarget } from "@/lib/voice/configuration";
import { targetFor } from "@/lib/voice/target";
import { assertSameOrigin, readBoundedJson } from "@/lib/voice/http";
import { REACTIONS, REACTION_CONFIDENCE, REACTION_INSTRUCTIONS } from "@/lib/voice/policy";
import { CLIENT_ID_RE } from "@/lib/ids";
import { allowVoiceRequest } from "@/lib/auth/throttle";

const Input = z.object({ conversationId: z.string().regex(CLIENT_ID_RE), context: z.string().min(1).max(5000), revision: z.number().int().nonnegative() }).strict();
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const p = await requirePrincipal();
    const input = Input.parse(await readBoundedJson(req));
    const target = await configureVoiceTarget(p, await targetFor(p, { conversationId: input.conversationId }));
    const settings = await getSetting("voice");
    let reaction = "keep_current";
    let confidence: number | null = null;
    const started = Date.now();
    if (settings.reactions && await allowVoiceRequest(p.user.id, "reaction")) {
      const ctx = await providerContextFor(target.voiceApp ?? target.app);
      const result = await requestDecision(ctx, input.context, [{ type: "choice", name: "gesture",
        instructions: REACTION_INSTRUCTIONS,
        choices: REACTIONS.map(value => ({ value, description: ({ keep_current: "Keep the existing pose", neutral: "Return to attentive listening", nod: "Brief acknowledgment", curious: "Tilt head with interest", smile: "Warm positive response", concerned: "Gentle sympathetic attention" })[value] })),
      }], { signal: req.signal, timeoutMs: 900 });
      const answer = result.status === "ok" ? result.answers[0] : null;
      if (answer?.type === "choice" && answer.name === "gesture" && Number.isFinite(answer.confidence) &&
          answer.confidence >= REACTION_CONFIDENCE && REACTIONS.includes(answer.choice as typeof REACTIONS[number])) {
        reaction = answer.choice; confidence = answer.confidence;
      }
    }
    return Response.json({ reaction, confidence, revision: input.revision, latencyMs: Date.now() - started }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
