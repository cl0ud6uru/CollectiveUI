import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { conversations } from "@/db/schema";
import { requirePrincipal, errorResponse } from "@/lib/session";
import { getOwnedConversation, HttpError } from "@/lib/authz";
import { resolveTurnTarget } from "@/lib/agent/target";
import { loadGroupMembers } from "@/lib/agent/group";
import { nativeSearchSelection } from "@/lib/agent/native-search";
import { lockUserRuns } from "@/lib/runs/lock";
import { activeRunOf } from "@/lib/runs/state";
import { getSetting } from "@/lib/settings";

export async function GET(req: Request) {
  try {
    const p = await requirePrincipal();
    const query = new URL(req.url).searchParams;
    const id = query.get("conversationId");
    const conv = id ? await getOwnedConversation(p, id) : null;
    const settings = await getSetting("tools");
    if (conv?.isGroup) {
      const members = await loadGroupMembers(p, conv.id);
      const choices = await Promise.all(members.map(m => nativeSearchSelection(m.app, m.bot, settings, "auto")));
      return Response.json({ mode: conv.nativeSearchMode ?? "auto", reason: choices.some(c => !c.reason) ? null : "None of this group's bots have native search available.", maxCalls: settings.nativeSearch?.maxCalls });
    }
    const { app, bot } = await resolveTurnTarget(p, conv ?? { appId: query.get("appId"), botId: query.get("botId") });
    return Response.json({ ...await nativeSearchSelection(app, bot, settings, conv?.nativeSearchMode), maxCalls: settings.nativeSearch?.maxCalls });
  } catch (err) {
    if (err instanceof z.ZodError) return Response.json({ error: "Invalid search setting" }, { status: 400 });
    return errorResponse(err);
  }
}

export async function PATCH(req: Request) {
  try {
    const p = await requirePrincipal();
    const { conversationId, mode } = z.object({ conversationId: z.string().min(1), mode: z.enum(["off", "auto"]) }).parse(await req.json());
    await db.transaction(async tx => {
      await lockUserRuns(tx, p.user.id);
      const [conv] = await tx.select().from(conversations).where(and(eq(conversations.id, conversationId), eq(conversations.userId, p.user.id))).for("update");
      if (!conv) throw new HttpError(404, "Conversation not found");
      if (conv.source === "delegation") throw new HttpError(403, "Delegated tasks are read-only.");
      if (await activeRunOf(conv.id, tx)) throw new HttpError(409, "Wait for the current reply to finish before changing search.");
      if (mode === "auto") {
        const settings = await getSetting("tools");
        const members = conv.isGroup ? await loadGroupMembers(p, conv.id) : [await resolveTurnTarget(p, conv)];
        const choices = await Promise.all(members.map(m => nativeSearchSelection(m.app, m.bot, settings, mode)));
        if (!choices.some(c => !c.reason)) throw new HttpError(403, choices[0]?.reason ?? "No eligible bots are available.");
      }
      await tx.update(conversations).set({ nativeSearchMode: mode }).where(eq(conversations.id, conv.id));
    });
    return Response.json({ mode });
  } catch (err) {
    if (err instanceof z.ZodError) return Response.json({ error: "Invalid search setting" }, { status: 400 });
    return errorResponse(err);
  }
}
