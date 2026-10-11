import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { requirePrincipal, errorResponse } from "@/lib/session";
import { HttpError } from "@/lib/authz";
import { targetFor } from "@/lib/voice/target";
import { getSetting } from "@/lib/settings";
import * as session from "@/app/api/voice/session/route";
import * as turn from "@/app/api/voice/turn/route";
import * as reaction from "@/app/api/voice/reaction/route";

type Context = { params: Promise<{ operation: string }> };

/** The mobile-only prefix requires a device token; shared handlers retain all target/run checks. */
export async function GET(req: Request, ctx: Context) {
  try {
    const principal = await requirePrincipal();
    const { operation } = await ctx.params;
    if (operation === "session") return session.GET(req);
    if (operation === "turn") return turn.GET(req);
    if (operation !== "avatar") throw new HttpError(404, "Unknown voice operation.");
    const conversationId = new URL(req.url).searchParams.get("conversationId") ?? "";
    await targetFor(principal, { conversationId });
    const { avatarUrl } = await getSetting("voice");
    if (!avatarUrl || !/^\/avatars\/[A-Za-z0-9_/-]+\.glb$/.test(avatarUrl)) throw new HttpError(404, "No avatar is configured.");
    const filename = path.join(process.cwd(), "public", avatarUrl);
    if ((await stat(filename)).size > 25 * 1024 * 1024) throw new HttpError(413, "Use an avatar smaller than 25 MB for mobile.");
    const file = await readFile(filename);
    if (file.byteLength > 25 * 1024 * 1024) throw new HttpError(413, "Use an avatar smaller than 25 MB for mobile.");
    return new Response(file, { headers: { "content-type": "model/gltf-binary", "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(req: Request, ctx: Context) {
  try {
    await requirePrincipal();
    const { operation } = await ctx.params;
    if (operation === "session") return session.POST(req);
    if (operation === "turn") return turn.POST(req);
    if (operation === "reaction") return reaction.POST(req);
    throw new HttpError(404, "Unknown voice operation.");
  } catch (error) { return errorResponse(error); }
}
