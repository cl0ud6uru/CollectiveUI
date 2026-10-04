import { deflateRawSync } from "node:zlib";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { parsePetUpload, validateV2Cells } from "@/lib/pets/import";
import { PET_ARCHIVE_MAX_BYTES, readPetArchive, writePetArchive } from "@/lib/pets/archive";
import { PET_ANIMATIONS, PET_DIRECTIONS } from "@/lib/pets/atlas";
import { petV2Fixture } from "../fixtures/pet-v2";

const manifest = { displayName: "Geometric fixture", description: "Original test pixels", spriteVersionNumber: 2 as const, credit: "Fixture · MIT" };
let sprite: Buffer;
beforeAll(async () => { sprite = await petV2Fixture(); });
function request(archive?: Buffer, json = { ...manifest, spritesheetPath: "spritesheet.png" }) {
  const form = new FormData();
  form.set("credit", ""); form.set("rights", "confirmed");
  if (archive) form.set("archive", new File([new Uint8Array(archive)], "sample.zip"));
  else { form.set("manifest", new File([JSON.stringify(json)], "pet.json")); form.set("sprite", new File([new Uint8Array(sprite)], "spritesheet.png")); }
  return new Request("http://localhost/api/pets", { method: "POST", body: form });
}
function patchEntry(zip: Buffer, name: string, update: (copy: Buffer, central: number, local: number) => void) {
  const copy = Buffer.from(zip); let cursor = copy.readUInt32LE(copy.length - 6);
  for (let n = 0; n < 2; n++) {
    const length = copy.readUInt16LE(cursor + 28);
    if (copy.toString("utf8", cursor + 46, cursor + 46 + length) === name) { update(copy, cursor, copy.readUInt32LE(cursor + 42)); return copy; }
    cursor += 46 + length;
  }
  throw new Error("entry missing");
}

describe("Codex Pet v2 builder", () => {
  it("covers all nine canonical animations and sixteen clockwise look cells", () => {
    expect(PET_ANIMATIONS.map(s => s.durations.length)).toEqual([6, 8, 8, 4, 5, 8, 6, 6, 6]);
    expect(PET_DIRECTIONS.filter(d => d.degrees % 90 === 0).map(d => [d.row, d.column, d.degrees])).toEqual([[9, 0, 0], [9, 4, 90], [10, 0, 180], [10, 4, 270]]);
  });
  it("validates a v2 upload and preserves attribution through ZIP export and reimport", async () => {
    const imported = await parsePetUpload(request());
    expect(imported.manifest).toEqual(manifest);
    const zip = writePetArchive(imported.manifest, imported.sprite);
    expect([...readPetArchive(zip).keys()]).toEqual(["pet.json", "spritesheet.png"]);
    const again = await parsePetUpload(request(zip));
    expect(again.manifest).toEqual(manifest); expect(again.sprite).toEqual(imported.sprite);
  });
  it("accepts bounded deflated ZIP entries", () => {
    const zip = writePetArchive(manifest, sprite);
    const files = readPetArchive(zip);
    const packed = [...files.values()].map(value => deflateRawSync(value));
    const local: Buffer[] = [], central: Buffer[] = []; let old = 0, offset = 0, cursor = zip.readUInt32LE(zip.length - 6);
    packed.forEach((bytes) => {
      const nameLength = zip.readUInt16LE(old + 26), header = Buffer.from(zip.subarray(old, old + 30 + nameLength));
      header.writeUInt16LE(8, 8); header.writeUInt32LE(bytes.length, 18); local.push(header, bytes);
      const entry = Buffer.from(zip.subarray(cursor, cursor + 46 + nameLength)); entry.writeUInt16LE(8, 10); entry.writeUInt32LE(bytes.length, 20); entry.writeUInt32LE(offset, 42); central.push(entry);
      old += 30 + nameLength + zip.readUInt32LE(old + 18); cursor += 46 + nameLength; offset += header.length + bytes.length;
    });
    const end = Buffer.from(zip.subarray(-22)); end.writeUInt32LE(offset, 16);
    expect(readPetArchive(Buffer.concat([...local, ...central, end]))).toEqual(files);
  });
  it("rejects new v1 imports and mismatched sprite references", async () => {
    expect(() => writePetArchive({ ...manifest, spriteVersionNumber: 1 }, sprite)).toThrow(/Only complete v2/);
    await expect(parsePetUpload(request(undefined, { ...manifest, spriteVersionNumber: 1 as 2, spritesheetPath: "spritesheet.png" }))).rejects.toThrow(/must use Codex Pet v2/);
    await expect(parsePetUpload(request(undefined, { ...manifest, spritesheetPath: "spritesheet.webp" }))).rejects.toThrow(/filename must match/);
  });
  it("reports missing animation, missing direction and nontransparent unused cells", async () => {
    await expect(validateV2Cells(sprite)).resolves.toBeUndefined();
    await expect(validateV2Cells(await sharp(sprite).greyscale().png().toBuffer())).resolves.toBeUndefined();
    const erased = await sharp(sprite).composite([{ input: { create: { width: 192, height: 208, channels: 4, background: "white" } }, left: 0, top: 9 * 208, blend: "dest-out" }]).png().toBuffer();
    await expect(validateV2Cells(erased)).rejects.toThrow(/look 0° · Up is empty/);
    const empty = await sharp({ create: { width: 1536, height: 2288, channels: 4, background: "transparent" } }).png().toBuffer();
    await expect(validateV2Cells(empty)).rejects.toThrow(/idle frame 1 is empty/);
    const full = await sharp({ create: { width: 1536, height: 2288, channels: 4, background: "white" } }).png().toBuffer();
    await expect(validateV2Cells(full)).rejects.toThrow(/idle unused cell 7 must be transparent/);
  });
  it("rejects corrupted, oversized, linked, encrypted, ambiguous and traversal ZIPs", () => {
    const zip = writePetArchive(manifest, sprite);
    for (const invalid of [Buffer.from("not a zip"), zip.subarray(0, -1), Buffer.alloc(PET_ARCHIVE_MAX_BYTES + 1),
      patchEntry(zip, "pet.json", (b, c, l) => { b.write("../x.txt", c + 46); b.write("../x.txt", l + 30); }),
      patchEntry(zip, "pet.json", (b, c) => b.writeUInt32LE(0xa1ff0000, c + 38)),
      patchEntry(zip, "pet.json", (b, c) => b.writeUInt16LE(1, c + 8)),
      patchEntry(zip, "pet.json", (b, c) => b.writeUInt16LE(8, c + 8)),
      patchEntry(zip, "pet.json", (b, c) => b.writeUInt32LE(0xffffffff, c + 24)),
      patchEntry(zip, "spritesheet.png", (b, c) => b.writeUInt32LE(0, c + 42)),
      patchEntry(zip, "pet.json", (b, _c, l) => b.writeUInt32LE(1, l + 14)),
      patchEntry(zip, "spritesheet.png", (b, c) => b.writeUInt32LE(1, c + 20)),
      patchEntry(zip, "pet.json", (b, _c, l) => { b[l + 30 + 8] ^= 0xff; }),
    ]) expect(() => readPetArchive(invalid)).toThrow();
  });
  it("rejects duplicate form entries and mixed archive/file inputs", async () => {
    const base = request(); const form = await base.formData();
    form.append("manifest", form.get("manifest")!);
    await expect(parsePetUpload(new Request(base.url, { method: "POST", body: form }))).rejects.toThrow(/one pet.json/);
    form.delete("manifest"); form.set("archive", new File([new Uint8Array(writePetArchive(manifest, sprite))], "pet.zip"));
    await expect(parsePetUpload(new Request(base.url, { method: "POST", body: form }))).rejects.toThrow(/either a pet ZIP/);
  });
});
