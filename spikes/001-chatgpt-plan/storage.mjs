import {
  mkdir,
  open,
  rename,
  readFile,
  lstat,
  unlink,
  link,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
export async function load(file) {
  try {
    const s = await lstat(file);
    if (!s.isFile() || s.mode & 0o077)
      throw Error("Unsafe credential file permissions");
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function directory(file) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const s = await lstat(dirname(file));
  if (!s.isDirectory() || s.mode & 0o077)
    throw Error("Storage directory must be owner-only");
}
export async function save(file, value) {
  file = resolve(file);
  await directory(file);
  const tmp = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(tmp, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tmp, file);
  } finally {
    await handle?.close();
    await unlink(tmp).catch(() => {});
  }
}
export async function hostId(file) {
  const path = resolve(dirname(file), "host.json");
  await directory(path);
  const existing = await load(path);
  if (existing) return existing.id;
  const id = `urn:uuid:${randomUUID()}`;
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const h = await open(tmp, "wx", 0o600);
    try {
      await h.writeFile(JSON.stringify({ id }));
      await h.sync();
    } finally {
      await h.close();
    }
    try {
      await link(tmp, path);
      return id;
    } catch (e) {
      if (e.code === "EEXIST") return (await load(path)).id;
      throw e;
    }
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
