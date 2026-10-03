import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** Pluggable blob storage. The local-disk adapter is used by default; swap for Azure Blob/S3 later. */
export interface StorageAdapter {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

class LocalDiskStorage implements StorageAdapter {
  constructor(private root: string) {}
  private resolve(key: string) {
    if (!/^[A-Za-z0-9/_.-]+$/.test(key) || key.includes("..")) throw new Error("Invalid storage key");
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error("Invalid storage key");
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.resolve(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  get(key: string) {
    return readFile(this.resolve(key));
  }
  async delete(key: string) {
    await unlink(this.resolve(key)).catch(() => {});
  }
}

let instance: StorageAdapter | undefined;
export function storage(): StorageAdapter {
  instance ??= new LocalDiskStorage(path.resolve(/*turbopackIgnore: true*/ process.env.STORAGE_DIR ?? "./data/uploads"));
  return instance;
}
