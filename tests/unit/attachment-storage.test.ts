import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDiskStorage } from "@/lib/files/storage";

const temporaryRoots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "collective-attachment-proof-"));
  temporaryRoots.push(root);
  return { root, adapter: new LocalDiskStorage(root) };
}
afterEach(async () => { for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("attachment storage deletion in temporary fixtures only", () => {
  it("removes known file bytes and treats an already absent key as success", async () => {
    const { root, adapter } = await fixture();
    await adapter.put("owner/file", Buffer.from("synthetic bytes"));
    await adapter.delete("owner/file");
    await expect(readFile(path.join(root, "owner/file"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(adapter.delete("owner/file")).resolves.toBeUndefined();
  });
  it("propagates non-ENOENT storage errors so cleanup keeps its retry metadata", async () => {
    const { root, adapter } = await fixture();
    await mkdir(path.join(root, "directory"));
    await expect(adapter.delete("directory")).rejects.toBeDefined();
  });
});
