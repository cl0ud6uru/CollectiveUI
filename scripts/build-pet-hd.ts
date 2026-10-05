/**
 * Build a bundled pet's two sheets from one 2× source (384 × 416 cells, 3072 × 4576 in all):
 *
 *   npx tsx scripts/build-pet-hd.ts <source-2x.png|webp | frames-directory> <output-directory>
 *
 * The source is either a finished 2× atlas or a directory of transparent 384 × 416 frames named `<row>-<frame>.png`
 * (row 0–10, frame from 1), the names scripts/export-pet-frames.ts writes. Writes `spritesheet.webp`, a standard
 * lossless Codex Pet v2 sheet shrunk from the source, and `spritesheet@2x.webp`, CollectiveUI's optional HD rendition.
 * pet.json is never touched. Both files pass the checks the installer runs; the printed hashes go in the pet's README,
 * tests/unit/bundled-pets.test.ts and BUNDLED_PETS (see assets/pets/README.md).
 */
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { PET_ANIMATIONS } from "../src/lib/pets/atlas";
import { assertHdMatches, HD_LIKENESS_LIMIT, hdDifference, normalizePetSprite, normalizePetSpriteHd, validateV2Cells } from "../src/lib/pets/import";
import { PET_HD_SCALE, PET_MAX_BYTES, PET_WIDTH } from "../src/lib/pets/shared";

const [source, out] = process.argv.slice(2);
if (!source || !out || process.argv.length !== 4) throw new Error("Usage: npx tsx scripts/build-pet-hd.ts <source-2x.png|webp | frames-directory> <output-directory>");
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const counts = [...PET_ANIMATIONS.map((state) => state.durations.length), 8, 8];
const [cellWidth, cellHeight, width, height] = [192 * PET_HD_SCALE, 208 * PET_HD_SCALE, PET_WIDTH * PET_HD_SCALE, 2288 * PET_HD_SCALE];

/** Places each required frame in its cell. Missing, extra or wrongly sized frames are errors, never padded or scaled. */
async function assemble(directory: string) {
  const cells = [];
  for (let row = 0; row < 11; row++) for (let frame = 1; frame <= counts[row]; frame++) {
    const file = path.join(directory, `${row}-${frame}.png`);
    const input = await readFile(file).catch(() => { throw new Error(`Missing frame ${file}.`); });
    const meta = await sharp(input).metadata();
    if (meta.width !== cellWidth || meta.height !== cellHeight || !meta.hasAlpha) throw new Error(`${file} must be a transparent ${cellWidth} × ${cellHeight} PNG; got ${meta.width} × ${meta.height}.`);
    cells.push({ input, left: (frame - 1) * cellWidth, top: row * cellHeight });
  }
  return sharp({ create: { width, height, channels: 4, background: "transparent" } }).composite(cells).png().toBuffer();
}

/**
 * Detailed art can push the decoded v2 PNG past the 4 MB import limit. As in the shipped Assimilated sheet, RGB is
 * then rounded to four-value steps (each channel moves at most 2 of 255); alpha, layout and scale are unchanged.
 */
async function fitImportLimit(standard: Buffer) {
  const { data, info } = await sharp(standard).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i + c] = Math.min(253, Math.round((data[i + c] - 1) / 4) * 4 + 1);
  return sharp(data, { raw: info }).webp({ lossless: true, effort: 6 }).toBuffer();
}

async function main() {
  const input = (await stat(source)).isDirectory() ? await assemble(source) : await readFile(source);
  const meta = await sharp(input).metadata();
  if (meta.width !== width || meta.height !== height || !meta.hasAlpha) throw new Error(`The source must be a ${width} × ${height} atlas with transparency; got ${meta.width} × ${meta.height}.`);

  // Lanczos reaches 6 source pixels; an 8-pixel clear border keeps every v2 frame edge transparent, like the shipped sheets.
  const { data } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const touching: string[] = [];
  for (let row = 0; row < 11; row++) for (let column = 0; column < counts[row]; column++) {
    const [left, top] = [column * cellWidth, row * cellHeight];
    let edge = false;
    for (let y = top; y < top + cellHeight && !edge; y++) for (let x = left; x < left + cellWidth; x++) {
      if ((x - left < 8 || left + cellWidth - x <= 8 || y - top < 8 || top + cellHeight - y <= 8) && data[(y * width + x) * 4 + 3]) { edge = true; break; }
    }
    if (edge) touching.push(`${row}-${column + 1}`);
  }
  if (touching.length) throw new Error(`Keep at least 8 transparent pixels around each ${cellWidth} × ${cellHeight} frame: ${touching.join(", ")}.`);

  let standard = await sharp(input).resize(PET_WIDTH, 2288, { kernel: "lanczos3" }).webp({ lossless: true, effort: 6 }).toBuffer();
  let normalized = await normalizePetSprite(standard, 2, "spritesheet.webp").catch(() => null);
  const fitted = !normalized;
  if (fitted) {
    standard = await fitImportLimit(standard);
    normalized = await normalizePetSprite(standard, 2, "spritesheet.webp");
  }
  const hd = await sharp(input).webp({ quality: 95, alphaQuality: 100, effort: 6 }).toBuffer();

  // The same normalization, cell and likeness checks the installer applies.
  await validateV2Cells(normalized!);
  const normalizedHd = await normalizePetSpriteHd(hd);
  await validateV2Cells(normalizedHd, PET_HD_SCALE);
  await assertHdMatches(normalized!, normalizedHd);

  await writeFile(path.join(out, "spritesheet.webp"), standard);
  await writeFile(path.join(out, "spritesheet@2x.webp"), hd);
  console.table({
    "spritesheet.webp": { bytes: standard.length, sha256: sha(standard) },
    "spritesheet@2x.webp": { bytes: hd.length, sha256: sha(hd) },
    "normalized v2 PNG (installer)": { bytes: normalized!.length, sha256: sha(normalized!) },
    "stored HD WebP (installer)": { bytes: normalizedHd.length, sha256: sha(normalizedHd) },
  });
  console.log(`HD likeness: ${(await hdDifference(normalized!, normalizedHd)).toFixed(3)} mean levels apart (limit ${HD_LIKENESS_LIMIT}).`);
  console.log(`Normalized v2 PNG uses ${(normalized!.length / PET_MAX_BYTES * 100).toFixed(1)}% of the 4 MB import limit${fitted ? ", after rounding RGB to four-value steps to fit" : ""}.`);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
