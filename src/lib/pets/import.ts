import sharp from "sharp";
import { z } from "zod";
import { HttpError } from "@/lib/authz";
import { MANIFEST_MAX_BYTES, PET_MAX_BYTES, PET_WIDTH, type PetManifest } from "./shared";

const text = (max: number) => z.string().trim().max(max).refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "Control characters are not supported");
const manifestSchema = z.object({
  displayName: text(80).min(1),
  description: text(1000).optional().default(""),
  spriteVersionNumber: z.union([z.literal(1), z.literal(2)]).optional().default(1),
  // This is a filename check, never a path to open or a URL to fetch.
  spritesheetPath: z.enum(["spritesheet.png", "spritesheet.webp"]),
  frameWidth: z.literal(192).optional(),
  frameHeight: z.literal(208).optional(),
  columns: z.literal(8).optional(),
  // Custom animation definitions aren't a supported format; reject rather than silently misrender.
  states: z.never().optional(),
  animations: z.never().optional(),
});

export function parsePetManifest(data: Buffer, credit: string): PetManifest & { spritesheetPath: string } {
  if (data.length > MANIFEST_MAX_BYTES) throw new HttpError(413, "pet.json must be 16 KB or smaller.");
  let value: unknown;
  try { value = JSON.parse(data.toString("utf8")); } catch { throw new HttpError(400, "pet.json must contain valid JSON."); }
  const result = manifestSchema.safeParse(value);
  const attribution = text(240).safeParse(credit);
  if (!result.success || !attribution.success) throw new HttpError(400, "Use a standard Codex pet.json: displayName, spritesheetPath, and optional spriteVersionNumber (1 or 2). Custom animation maps are not supported. Credit must be plain text up to 240 characters.");
  return { displayName: result.data.displayName, description: result.data.description, spriteVersionNumber: result.data.spriteVersionNumber, spritesheetPath: result.data.spritesheetPath, credit: attribution.data };
}

/** Bound actual bytes before parsing multipart/JSON, including requests without Content-Length. */
export async function readPetBody(request: Request, max: number): Promise<Buffer> {
  if (Number(request.headers.get("content-length")) > max) throw new HttpError(413, "Pet upload is too large.");
  if (!request.body) throw new HttpError(400, "Missing request body.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); throw new HttpError(413, "Pet upload is too large."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

/** Only static PNG/WebP rasters, canonical dimensions, and freshly encoded pixels reach storage. */
export async function normalizePetSprite(data: Buffer, version: 1 | 2, filename: string): Promise<Buffer> {
  if (!data.length || data.length > PET_MAX_BYTES) throw new HttpError(413, "The sprite must be between 1 byte and 4 MB.");
  const format = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png"
    : data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP" ? "webp" : null;
  if (!format || filename !== `spritesheet.${format}`) throw new HttpError(415, "Choose a static spritesheet.png or spritesheet.webp matching pet.json. SVG, HTML and archives are not supported.");
  try {
    // libvips may decode only the first APNG frame. Reject its animation marker explicitly.
    if (format === "png") {
      for (let offset = 8; offset + 12 <= data.length;) {
        const length = data.readUInt32BE(offset);
        if (data.toString("ascii", offset + 4, offset + 8) === "acTL") throw new Error("Animated PNG");
        offset += length + 12;
      }
    } else if (data.toString("ascii", 12, 16) === "VP8X" && (data[20] & 2)) {
      throw new Error("Animated WebP");
    }
    const sprite = sharp(data, { limitInputPixels: PET_WIDTH * 2288, failOn: "warning" }).timeout({ seconds: 5 });
    const meta = await sprite.metadata();
    const height = version === 2 ? 2288 : 1872;
    if (meta.format !== format || meta.width !== PET_WIDTH || meta.height !== height || (meta.pages ?? 1) !== 1) throw new Error("Invalid atlas");
    const png = await sprite.png().toBuffer();
    if (png.length > PET_MAX_BYTES) throw new Error("Encoded image is too large");
    return png;
  } catch {
    throw new HttpError(400, `Use an undamaged static ${PET_WIDTH} × ${version === 2 ? 2288 : 1872} sprite sheet (maximum 4 MB after decoding and encoding).`);
  }
}

export function assertPetOrigin(request: Request) {
  const expected = new URL(process.env.AUTH_URL || request.url).origin;
  if (request.headers.get("origin") !== expected) throw new HttpError(403, "Invalid request origin");
}

/** Shared by private imports and admin catalog drafts; all callers authorize before decoding. */
export async function parsePetUpload(request: Request) {
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("multipart/form-data;")) throw new HttpError(415, "Choose pet.json and a sprite sheet.");
  const body = await readPetBody(request, PET_MAX_BYTES + MANIFEST_MAX_BYTES + 8192);
  let form: FormData;
  try { form = await new Response(new Uint8Array(body), { headers: { "Content-Type": type } }).formData(); }
  catch { throw new HttpError(400, "Invalid upload."); }
  const manifestFile = form.get("manifest"), spriteFile = form.get("sprite"), credit = form.get("credit");
  if (form.get("rights") !== "confirmed") throw new HttpError(400, "Confirm you have permission to use and share this artwork.");
  if (form.getAll("manifest").length !== 1 || form.getAll("sprite").length !== 1 || !(manifestFile instanceof File) || !(spriteFile instanceof File) || manifestFile.name !== "pet.json" || typeof credit !== "string") throw new HttpError(400, "Choose one pet.json and one matching sprite sheet.");
  const { spritesheetPath, ...manifest } = parsePetManifest(Buffer.from(await manifestFile.arrayBuffer()), credit);
  if (spriteFile.name !== spritesheetPath) throw new HttpError(400, "The sprite filename must match spritesheetPath in pet.json.");
  const sprite = await normalizePetSprite(Buffer.from(await spriteFile.arrayBuffer()), manifest.spriteVersionNumber, spriteFile.name);
  return { manifest, sprite, rights: "confirmed" as const };
}

export async function parsePetJson(request: Request): Promise<unknown> {
  try { return JSON.parse((await readPetBody(request, 1024)).toString("utf8")); }
  catch (err) { if (err instanceof HttpError) throw err; throw new HttpError(400, "Invalid pet request."); }
}
