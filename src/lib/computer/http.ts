import { z } from "zod";
import { HttpError } from "@/lib/authz";

const conversationIdSchema = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);

export function queryConversationId(request: Request): string {
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some(key => key !== "conversationId") || query.getAll("conversationId").length !== 1)
    throw new HttpError(400, "Invalid computer-view request.");
  const parsed = conversationIdSchema.safeParse(query.get("conversationId"));
  if (!parsed.success) throw new HttpError(400, "Invalid computer-view request.");
  return parsed.data;
}
export async function readComputerJson(request: Request, maxBytes = 8 * 1024): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new HttpError(415, "JSON required.");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Invalid computer request.");
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new HttpError(413, "Computer request is too large."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "Invalid computer request."); }
}
