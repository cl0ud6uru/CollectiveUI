import { crc32, inflateRawSync } from "node:zlib";
import { HttpError } from "@/lib/authz";
import { MANIFEST_MAX_BYTES, PET_MAX_BYTES, type PetManifest } from "./shared";

export const PET_ARCHIVE_MAX_BYTES = PET_MAX_BYTES + MANIFEST_MAX_BYTES + 4096;
const names = new Set(["pet.json", "spritesheet.png", "spritesheet.webp"]);
const invalid = () => new HttpError(400, "Use a ZIP containing only pet.json and spritesheet.png or spritesheet.webp at its root. Encrypted, streaming, ZIP64, nested and linked entries are not supported.");

/** A deliberately narrow ZIP reader. Never extracts paths; caps bytes before inflating either entry. */
export function readPetArchive(data: Buffer): Map<string, Buffer> {
  if (data.length > PET_ARCHIVE_MAX_BYTES) throw new HttpError(413, "Pet ZIP must be 4 MB plus a 16 KB manifest or smaller.");
  try {
    if (data.length < 22) throw invalid();
    let end = data.length - 22;
    while (end >= Math.max(0, data.length - 65557) && data.readUInt32LE(end) !== 0x06054b50) end--;
    if (end < 0 || data.readUInt32LE(end) !== 0x06054b50 || end + 22 + data.readUInt16LE(end + 20) !== data.length) throw invalid();
    if (data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6) || data.readUInt16LE(end + 8) !== 2 || data.readUInt16LE(end + 10) !== 2) throw invalid();
    const directory = data.readUInt32LE(end + 16);
    if (directory + data.readUInt32LE(end + 12) !== end) throw invalid();
    const files = new Map<string, Buffer>();
    let cursor = directory, localCursor = 0;
    for (let n = 0; n < 2; n++) {
      if (cursor + 46 > end || data.readUInt32LE(cursor) !== 0x02014b50) throw invalid();
      const flags = data.readUInt16LE(cursor + 8), method = data.readUInt16LE(cursor + 10);
      const checksum = data.readUInt32LE(cursor + 16), compressed = data.readUInt32LE(cursor + 20), size = data.readUInt32LE(cursor + 24);
      const nameLength = data.readUInt16LE(cursor + 28), extraLength = data.readUInt16LE(cursor + 30), commentLength = data.readUInt16LE(cursor + 32);
      const offset = data.readUInt32LE(cursor + 42), unixMode = data.readUInt32LE(cursor + 38) >>> 16;
      const name = data.toString("utf8", cursor + 46, cursor + 46 + nameLength);
      if (cursor + 46 + nameLength + extraLength + commentLength > end || !names.has(name) || files.has(name) || nameLength !== Buffer.byteLength(name)) throw invalid();
      if ((flags & ~0x800) || ![0, 8].includes(method) || data.readUInt16LE(cursor + 34) || (unixMode & 0xf000) && (unixMode & 0xf000) !== 0x8000) throw invalid();
      const max = name === "pet.json" ? MANIFEST_MAX_BYTES : PET_MAX_BYTES;
      if (!size || size > max || compressed > PET_ARCHIVE_MAX_BYTES || offset !== localCursor || offset + 30 > directory || data.readUInt32LE(offset) !== 0x04034b50) throw invalid();
      const localNameLength = data.readUInt16LE(offset + 26), localExtraLength = data.readUInt16LE(offset + 28);
      const start = offset + 30 + localNameLength + localExtraLength;
      if (data.readUInt16LE(offset + 6) !== flags || data.readUInt16LE(offset + 8) !== method || data.readUInt32LE(offset + 14) !== checksum || data.readUInt32LE(offset + 18) !== compressed || data.readUInt32LE(offset + 22) !== size || localNameLength !== nameLength || data.toString("utf8", offset + 30, offset + 30 + localNameLength) !== name || start + compressed > directory) throw invalid();
      const bytes = data.subarray(start, start + compressed);
      const result = method === 0 ? bytes : inflateRawSync(bytes, { maxOutputLength: max });
      if (result.length !== size || crc32(result) !== checksum) throw invalid();
      files.set(name, result);
      localCursor = start + compressed;
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    if (cursor !== end || localCursor !== directory || !files.has("pet.json") || files.size !== 2) throw invalid();
    return files;
  } catch (error) { if (error instanceof HttpError) throw error; throw invalid(); }
}

/** Canonical, uncompressed ZIP; no uploaded filenames, paths or optional metadata are propagated. */
export function writePetArchive(manifest: PetManifest, sprite: Buffer): Buffer {
  if (manifest.spriteVersionNumber !== 2) throw new HttpError(400, "Only complete v2 pets can be exported as v2.");
  const entries = [
    ["pet.json", Buffer.from(JSON.stringify({ ...manifest, spriteVersionNumber: 2, spritesheetPath: "spritesheet.png" }, null, 2))],
    ["spritesheet.png", sprite],
  ] as const;
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    const filename = Buffer.from(name), checksum = crc32(bytes);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(checksum, 16); entry.writeUInt32LE(bytes.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(local, filename, bytes); central.push(entry, filename); offset += local.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(2, 8); end.writeUInt16LE(2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
