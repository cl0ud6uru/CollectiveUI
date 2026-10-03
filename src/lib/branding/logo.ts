import sharp from "sharp";
import { HttpError } from "@/lib/authz";
import { LOGO_MAX_BYTES, LOGO_TYPES } from "./shared";

/** Bound the stream as well as Content-Length; don't buffer an untrusted multipart body. */
export async function readLogoBody(request: Request): Promise<Buffer> {
  if (!LOGO_TYPES.includes(request.headers.get("content-type") ?? "")) {
    throw new HttpError(415, "Choose a PNG, JPEG, or WebP image.");
  }
  if (Number(request.headers.get("content-length")) > LOGO_MAX_BYTES) throw new HttpError(413, "Logos must be 2 MB or smaller.");
  if (!request.body) throw new HttpError(400, "Choose an image to upload.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LOGO_MAX_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "Logos must be 2 MB or smaller.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/** Decode only raster formats, cap pixels, and re-encode. Never retain original bytes or metadata. */
export async function normalizeLogo(data: Buffer, contentType: string): Promise<Buffer> {
  if (!data.length) throw new HttpError(400, "Choose an image to upload.");
  if (data.length > LOGO_MAX_BYTES) throw new HttpError(413, "Logos must be 2 MB or smaller.");
  const format = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png"
    : data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff ? "jpeg"
    : data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP" ? "webp" : null;
  if (!format || contentType !== `image/${format}`) throw new HttpError(415, "Choose a valid PNG, JPEG, or WebP image.");
  try {
    const image = sharp(data, { limitInputPixels: 4_194_304, failOn: "warning" });
    const meta = await image.metadata();
    if (meta.format !== format || !meta.width || !meta.height || meta.width > 2048 || meta.height > 2048 || (meta.pages ?? 1) > 1) {
      throw new Error("Unsupported dimensions or animation");
    }
    return await image.rotate().resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  } catch {
    throw new HttpError(400, "Use a static, undamaged image up to 2048 × 2048 pixels.");
  }
}

export function assertBrandingOrigin(request: Request) {
  // Browsers send Origin on both mutations. Do not trust forwarded host headers.
  const expected = new URL(process.env.AUTH_URL || request.url).origin;
  if (request.headers.get("origin") !== expected) throw new HttpError(403, "Invalid request origin");
}
