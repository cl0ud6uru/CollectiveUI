// Compatibility-only atlas assembly. Required source frame pixels are never redrawn or resampled.
import sharp from "sharp";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../assets/pets/the-queen/", import.meta.url);
const counts = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8];
const { data, info } = await sharp(fileURLToPath(new URL("source/spritesheet.png", root))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
if (info.width !== 1536 || info.height !== 2288 || info.channels !== 4) throw new Error("Unexpected Queen source atlas");
for (let row = 0; row < counts.length; row++) {
  for (let y = row * 208; y < (row + 1) * 208; y++) {
    data.fill(0, (y * 1536 + counts[row] * 192) * 4, (y * 1536 + 1536) * 4);
  }
}
await sharp(data, { raw: info }).png().toFile(fileURLToPath(new URL("v2/spritesheet.png", root)));
const manifest = JSON.parse(await readFile(new URL("source/pet.json", root), "utf8"));
manifest.credit = "AI-assisted design; vector production artwork adapted from CollectiveUI's original MIT-licensed Moss/Ember visual family.";
await writeFile(new URL("v2/pet.json", root), JSON.stringify(manifest, null, 2) + "\n");
