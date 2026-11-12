import { HttpError } from "@/lib/authz";
const MAX_BODY_BYTES = 64_000;

export async function readBoundedJson(req: Request): Promise<unknown> {
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
