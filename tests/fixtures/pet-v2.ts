import sharp from "sharp";
// Original geometric test pixels, deliberately no artist assets or generation service.
export async function petV2Fixture() {
  const counts = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8];
  const cells = counts.flatMap((count, row) => Array.from({ length: count }, (_, column) => ({
    input: { create: { width: 80, height: 100, channels: 4 as const, background: { r: 70 + column * 15, g: 140, b: 100 + row * 10, alpha: 1 } } },
    left: column * 192 + 56, top: row * 208 + 60,
  })));
  return sharp({ create: { width: 1536, height: 2288, channels: 4, background: "transparent" } }).composite(cells).png().toBuffer();
}
