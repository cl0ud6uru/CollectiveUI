import { HttpError } from "@/lib/authz";
const MAX_BODY_BYTES = 64_000;

export function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return;
  try {
    const expectedOrigin = new URL(process.env.AUTH_URL || req.url).origin;
    if (new URL(origin).origin !== expectedOrigin) throw new HttpError(403, "Cross-origin request denied.");
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(403, "Invalid request origin.");
  }
}

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
