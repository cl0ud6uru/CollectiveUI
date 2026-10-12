import { z } from "zod";
import { assertAuthOrigin } from "@/lib/auth/origin";
import { HttpError } from "@/lib/authz";
import { errorResponse, requirePrincipal } from "@/lib/session";
import { SandboxError } from "@/lib/sandbox/client";
import { assignTemplate } from "@/lib/workspaces/instances";

const input = z.object({
  botId: z.string().min(1).max(128),
  templateVersionId: z.string().min(1).max(128),
}).strict();

export async function POST(req: Request) {
  try {
    assertAuthOrigin(req.headers);
    const principal = await requirePrincipal();
    if (!req.headers.get("content-type")?.startsWith("application/json")) throw new HttpError(415, "JSON required");
    const reader = req.body?.getReader();
    if (!reader) throw new HttpError(400, "Invalid workspace assignment");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) {
        await reader.cancel();
        throw new HttpError(413, "Workspace assignment is too large");
      }
      chunks.push(value);
    }
    let raw: unknown;
    try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new HttpError(400, "Invalid workspace assignment"); }
    const parsed = input.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, "Invalid workspace assignment");
    const instance = await assignTemplate({ principal, ...parsed.data });
    return Response.json({ instance }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    if (err instanceof SandboxError) {
      const status = ["image_missing", "docker_unavailable", "capacity", "unreachable", "timeout", "not_configured"].includes(err.code) ? 503 : 409;
      return errorResponse(new HttpError(status, err.message));
    }
    return errorResponse(err);
  }
}
