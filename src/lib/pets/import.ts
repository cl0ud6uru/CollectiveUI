import sharp from "sharp";
import { z } from "zod";
import { PET_ANIMATIONS, PET_DIRECTIONS } from "./atlas";
import { PET_ARCHIVE_MAX_BYTES, readPetArchive } from "./archive";
import { HttpError } from "@/lib/authz";
import { MANIFEST_MAX_BYTES, PET_HD_MAX_BYTES, PET_HD_SCALE, PET_MAX_BYTES, PET_WIDTH, type PetManifest } from "./shared";

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

const rasterFormat = (data: Buffer) => data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png" as const
  : data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP" ? "webp" as const : null;

/** libvips may decode only the first APNG or animated WebP frame. Reject their animation markers explicitly. */
function assertStill(data: Buffer, format: "png" | "webp") {
  if (format === "png") {
    for (let offset = 8; offset + 12 <= data.length;) {
      const length = data.readUInt32BE(offset);
      if (data.toString("ascii", offset + 4, offset + 8) === "acTL") throw new Error("Animated PNG");
      offset += length + 12;
    }
  } else if (data.toString("ascii", 12, 16) === "VP8X" && (data[20] & 2)) {
    throw new Error("Animated WebP");
  }
}

/** Only static PNG/WebP rasters, canonical dimensions, and freshly encoded pixels reach storage. */
export async function normalizePetSprite(data: Buffer, version: 1 | 2, filename: string): Promise<Buffer> {
  if (!data.length || data.length > PET_MAX_BYTES) throw new HttpError(413, "The sprite must be between 1 byte and 4 MB.");
  const format = rasterFormat(data);
  if (!format || filename !== `spritesheet.${format}`) throw new HttpError(415, "Choose a static spritesheet.png or spritesheet.webp matching pet.json. SVG, HTML and archives are not supported.");
  try {
    assertStill(data, format);
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

/**
 * The optional HD rendition: the same static-raster rules at exactly PET_HD_SCALE × the v2 sheet, re-encoded as WebP
 * with lossless alpha so it stays small enough to serve. Callers also run validateV2Cells and assertHdMatches.
 */
export async function normalizePetSpriteHd(data: Buffer): Promise<Buffer> {
  const [width, height] = [PET_WIDTH * PET_HD_SCALE, 2288 * PET_HD_SCALE];
  const failure = () => new HttpError(400, `Use an undamaged static ${width} × ${height} HD sprite sheet (maximum 12 MB).`);
  const format = rasterFormat(data);
  if (!data.length || data.length > PET_HD_MAX_BYTES || !format) throw failure();
  try {
    assertStill(data, format);
    // Encoding 14 megapixels takes several seconds on a small server; it runs once per installed or upgraded pet.
    const sprite = sharp(data, { limitInputPixels: width * height, failOn: "warning" }).timeout({ seconds: 60 });
    const meta = await sprite.metadata();
    if (meta.format !== format || meta.width !== width || meta.height !== height || (meta.pages ?? 1) !== 1) throw new Error("Invalid atlas");
    const webp = await sprite.webp({ quality: 92, alphaQuality: 100, effort: 4 }).toBuffer();
    if (webp.length > PET_HD_MAX_BYTES) throw new Error("Encoded image is too large");
    return webp;
  } catch { throw failure(); }
}

/** Premultiplied RGBA at v2 size, so differences in invisible colour never count. */
async function premultiplied(sprite: Buffer, scale: number) {
  const pipeline = sharp(sprite, { limitInputPixels: PET_WIDTH * 2288 * scale * scale }).timeout({ seconds: 10 }).toColourspace("srgb").ensureAlpha();
  const { data } = await (scale === 1 ? pipeline : pipeline.resize(PET_WIDTH, 2288, { kernel: "lanczos3" })).raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i + c] = Math.round(data[i + c] * data[i + 3] / 255);
  return data;
}

export const HD_LIKENESS_LIMIT = 4;

/** Mean absolute difference, per 8-bit channel, between the HD sheet shrunk to v2 size and the v2 sheet itself. */
export async function hdDifference(sprite: Buffer, hd: Buffer): Promise<number> {
  const [a, b] = await Promise.all([premultiplied(sprite, 1), premultiplied(hd, PET_HD_SCALE)]);
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

/**
 * The HD sheet must be the same artwork, frame for frame, as the v2 sheet everyone else sees. A sheet produced by
 * scripts/build-pet-hd.ts differs by about one level and a smooth 2× enlargement of
 * the same sheet by about two; different art (Hermes against Hermes Assimilated) differs by about twenty.
 */
export async function assertHdMatches(sprite: Buffer, hd: Buffer): Promise<void> {
  if (await hdDifference(sprite, hd) > HD_LIKENESS_LIMIT) throw new HttpError(400, "The HD sprite sheet must be the same artwork as the v2 sheet at twice the size. Build both from one 2× source with scripts/build-pet-hd.ts.");
}

/** Structural checks are deterministic; visual identity, gaze semantics and animation quality need human review. */
export async function validateV2Cells(sprite: Buffer, scale = 1): Promise<void> {
  const [width, height, cellWidth, cellHeight] = [PET_WIDTH * scale, 2288 * scale, 192 * scale, 208 * scale];
  const { data, info } = await sharp(sprite, { limitInputPixels: width * height }).timeout({ seconds: 5 * scale }).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    .catch(() => { throw new HttpError(400, `Use an undamaged static ${width} × ${height} Codex Pet v2 sprite sheet.`); });
  if (info.width !== width || info.height !== height) throw new HttpError(400, `V2 validation requires a ${width} × ${height} sprite sheet.`);
  const occupied = Array.from({ length: 11 }, () => Array<boolean>(8).fill(false));
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if (data[(y * info.width + x) * 4 + 3] > 0) occupied[Math.floor(y / cellHeight)][Math.floor(x / cellWidth)] = true;
  }
  const errors: string[] = [];
  PET_ANIMATIONS.forEach((state, row) => {
    for (let column = 0; column < 8; column++) {
      if (column < state.durations.length && !occupied[row][column]) errors.push(`${state.name} frame ${column + 1} is empty`);
      if (column >= state.durations.length && occupied[row][column]) errors.push(`${state.name} unused cell ${column + 1} must be transparent`);
    }
  });
  PET_DIRECTIONS.forEach(({ row, column, label }) => { if (!occupied[row][column]) errors.push(`look ${label} is empty`); });
  if (errors.length) throw new HttpError(400, `Fix these v2 cells: ${errors.slice(0, 8).join("; ")}${errors.length > 8 ? `; and ${errors.length - 8} more` : ""}.`);
}

/** Shared by validation, private imports, admin drafts and export. All callers authorize before decoding. */
export async function parsePetUpload(request: Request) {
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("multipart/form-data;")) throw new HttpError(415, "Choose pet.json and a sprite sheet, or a pet ZIP.");
  const body = await readPetBody(request, PET_ARCHIVE_MAX_BYTES + 8192);
  let form: FormData;
  try { form = await new Response(new Uint8Array(body), { headers: { "Content-Type": type } }).formData(); }
  catch { throw new HttpError(400, "Invalid upload."); }
  if (form.get("rights") !== "confirmed") throw new HttpError(400, "Confirm you have permission to use and share this artwork.");
  const credit = form.get("credit");
  if (typeof credit !== "string" || form.getAll("credit").length !== 1 || form.getAll("rights").length !== 1) throw new HttpError(400, "Supply one plain-text credit and one artwork permission confirmation.");
  let manifestBytes: Buffer, spriteBytes: Buffer, spriteName: string;
  const archive = form.get("archive");
  if (archive instanceof File && archive.size) {
    if (form.getAll("archive").length !== 1 || form.has("manifest") || form.has("sprite")) throw new HttpError(400, "Choose either a pet ZIP or the two individual files.");
    const files = readPetArchive(Buffer.from(await archive.arrayBuffer()));
    manifestBytes = files.get("pet.json")!;
    spriteName = files.has("spritesheet.png") ? "spritesheet.png" : "spritesheet.webp";
    spriteBytes = files.get(spriteName)!;
  } else {
    const manifestFile = form.get("manifest"), spriteFile = form.get("sprite");
    if (form.getAll("manifest").length !== 1 || form.getAll("sprite").length !== 1 || !(manifestFile instanceof File) || !(spriteFile instanceof File) || manifestFile.name !== "pet.json") throw new HttpError(400, "Choose one pet.json and one matching sprite sheet.");
    manifestBytes = Buffer.from(await manifestFile.arrayBuffer());
    spriteBytes = Buffer.from(await spriteFile.arrayBuffer()); spriteName = spriteFile.name;
  }
  const { spritesheetPath, ...manifest } = parsePetManifest(manifestBytes, credit);
  if (manifest.spriteVersionNumber !== 2) throw new HttpError(400, "New pets must use Codex Pet v2. Set spriteVersionNumber to 2 and provide all nine animation rows and sixteen look directions in a 1536 × 2288 sheet. Existing v1 pets remain available.");
  if (spriteName !== spritesheetPath) throw new HttpError(400, "The sprite filename must match spritesheetPath in pet.json.");
  // An exported archive carries its attribution; an explicit user credit may replace it.
  if (!credit.trim()) {
    const embedded = text(240).safeParse(JSON.parse(manifestBytes.toString("utf8")).credit ?? "");
    if (!embedded.success) throw new HttpError(400, "The embedded credit must be plain text up to 240 characters.");
    manifest.credit = embedded.data;
  }
  const sprite = await normalizePetSprite(spriteBytes, 2, spriteName);
  await validateV2Cells(sprite);
  return { manifest, sprite, rights: "confirmed" as const };
}

export async function parsePetJson(request: Request): Promise<unknown> {
  try { return JSON.parse((await readPetBody(request, 1024)).toString("utf8")); }
  catch (err) { if (err instanceof HttpError) throw err; throw new HttpError(400, "Invalid pet request."); }
}
