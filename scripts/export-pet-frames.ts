/**
 * Cut a Codex Pet v2 sheet into its 73 frames, enlarged 2× as references for redrawing:
 *
 *   npx tsx scripts/export-pet-frames.ts <spritesheet.png|webp> <output-directory>
 *
 * Writes transparent 384 × 416 PNGs named `<row>-<frame>.png` (row 0–10, frame from 1), the names
 * scripts/build-pet-hd.ts reads back. The enlargements are soft by design: they fix pose, framing and identity for
 * an image model to redraw at full detail, and are never shipped themselves.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { PET_ANIMATIONS } from "../src/lib/pets/atlas";
import { PET_HD_SCALE } from "../src/lib/pets/shared";

const [sheet, out] = process.argv.slice(2);
if (!sheet || !out || process.argv.length !== 4) throw new Error("Usage: npx tsx scripts/export-pet-frames.ts <spritesheet.png|webp> <output-directory>");
const counts = [...PET_ANIMATIONS.map((state) => state.durations.length), 8, 8];

async function main() {
  const meta = await sharp(sheet).metadata();
  if (meta.width !== 1536 || meta.height !== 2288) throw new Error(`Expected a 1536 × 2288 Codex Pet v2 sheet; got ${meta.width} × ${meta.height}.`);
  await mkdir(out, { recursive: true });
  for (let row = 0; row < 11; row++) for (let frame = 1; frame <= counts[row]; frame++) {
    await sharp(sheet).extract({ left: (frame - 1) * 192, top: row * 208, width: 192, height: 208 })
      .resize(192 * PET_HD_SCALE, 208 * PET_HD_SCALE, { kernel: "lanczos3" }).png().toFile(path.join(out, `${row}-${frame}.png`));
  }
  console.log(`Wrote ${counts.reduce((a, b) => a + b)} reference frames to ${out}.`);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
