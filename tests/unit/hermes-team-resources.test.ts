import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  assertSafeResourcePath, capturePublishableResources, createTeamResourceSnapshot,
  resourceBytes, resourceSha256, reviewTeamResourceChanges, selectTeamResourcePublication, validateTeamResourceSnapshot,
} from "@/lib/hermes-team/resources";

let root: string;
async function file(name: string, content: string | Buffer) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), content);
}
beforeEach(async () => { root = await mkdtemp("/tmp/hermes-team-resources-"); await file("skills/support/SKILL.md", "# Support\nUse scripts/check.py and assets/logo.bin.\n"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const capture = (selection = { skillPackages: ["support"] }) => capturePublishableResources(root, selection, { settleMs: 0 });

describe("Hermes Team Bot immutable resource capture", () => {
  it("captures exact complete packages, selected knowledge and role without executing scripts", async () => {
    await file("skills/support/scripts/check.py", "raise RuntimeError('must never execute')\n");
    await file("skills/support/assets/logo.bin", Buffer.from([0, 128, 255]));
    await file("documents/runbook.md", "Escalate to support."); await file("documents/private.md", "Do not select me.");
    await file("SOUL.md", "Support assistant.");
    const snapshot = await capturePublishableResources(root, { skillPackages: ["support", "support"], includeRole: true, documents: ["runbook.md"] }, { settleMs: 0 });
    expect(snapshot.resources.map(item => item.path)).toEqual(["SOUL.md", "documents/runbook.md", "skills/support/SKILL.md", "skills/support/assets/logo.bin", "skills/support/scripts/check.py"]);
    expect(snapshot.resources.filter(item => item.kind === "skill").every(item => item.packageId === "skills/support")).toBe(true);
    expect(resourceBytes(snapshot.resources.find(item => item.path.endsWith("logo.bin"))!)).toEqual(Buffer.from([0, 128, 255]));
    expect(Object.isFrozen(snapshot.resources[0])).toBe(true); expect(Object.isFrozen(snapshot.resources)).toBe(true);
    expect(validateTeamResourceSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    expect((await capturePublishableResources(root, { documents: ["runbook.md"], includeRole: true, skillPackages: ["support"] }, { settleMs: 0 })).manifestHash).toBe(snapshot.manifestHash);
    await file("skills/support/SKILL.md", "A later native improvement.");
    expect(snapshot.resources.find(item => item.path.endsWith("SKILL.md"))!.content).toContain("# Support");
  });
  it("never clones private native state or credential/config/cache files nested in a selected package", async () => {
    for (const name of ["auth.json", ".env", "memory/MEMORY.md", "history/chats.json", "browser/cookies.json", "logs/run.log", "cache/value.txt", "config.yaml", "credentials.json", "sessions/messages.json", "__pycache__/compiled.pyc"]) await file("skills/support/" + name, "private");
    for (const name of ["auth.json", "memories/MEMORY.md", "state.db", "config.yaml"]) await file(name, "private profile state");
    expect((await capture()).resources.map(item => item.path)).toEqual(["skills/support/SKILL.md"]);
    await expect(capturePublishableResources(root, { documents: ["auth.json"] }, { settleMs: 0 })).rejects.toThrow("Excluded");
  });
  it.each(["../auth.json", "/etc/passwd", "one/../../auth", "one\\two", "one//two", "one/./two", "%2e%2e/file", "C:/auth", "a\u0000b", "a\nb", ".env", "history/chat.md"])("rejects adversarial selection %s", async value => {
    expect(() => assertSafeResourcePath(value)).toThrow();
    await expect(capturePublishableResources(root, { skillPackages: [value] }, { settleMs: 0 })).rejects.toThrow();
  });
  it("rejects symlink roots, package paths, and leaves rather than reading their targets", async () => {
    await symlink(root, root + "-alias");
    try { await expect(capturePublishableResources(root + "-alias", { skillPackages: ["support"] }, { settleMs: 0 })).rejects.toThrow("canonical"); }
    finally { await rm(root + "-alias"); }
    await file("outside.md", "private"); await symlink(path.join(root, "outside.md"), path.join(root, "skills/support/leak.md"));
    await expect(capture()).rejects.toThrow("real files");
    await rm(path.join(root, "skills/support/leak.md"));
    await symlink(path.join(root, "skills/support"), path.join(root, "skills/alias"));
    await expect(capture({ skillPackages: ["alias"] })).rejects.toThrow("real directories");
  });
  it("rejects hardlinks and special files without blocking on a FIFO", async () => {
    await file("private.md", "private"); await link(path.join(root, "private.md"), path.join(root, "skills/support/leak.md"));
    await expect(capture()).rejects.toThrow("hardlinks"); await rm(path.join(root, "skills/support/leak.md"));
    execFileSync("mkfifo", [path.join(root, "skills/support/fifo")]);
    await expect(capture()).rejects.toThrow("special files");
  });
  it.each([
    "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----",
    "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
    'refresh_token: "abcdefghijklmnopqrstuvwxyz0123456789"',
  ])("rejects credential-like content even in allowlisted skill scripts", async secret => {
    await file("skills/support/scripts/code.py", secret);
    await expect(capture()).rejects.toThrow("credential-like");
  });
  it("captures environment-variable references without copying the referenced secret", async () => {
    await file("skills/support/scripts/check.py", 'api_key = os.environ["API_KEY"]\n');
    expect((await capture()).resources).toHaveLength(2);
  });
  it("rejects changes, additions or directory replacement between settled scans", async () => {
    await expect(capturePublishableResources(root, { skillPackages: ["support"] }, { waitForSettledWrites: () => file("skills/support/SKILL.md", "Native learning changed it.") })).rejects.toThrow("settled");
    await expect(capturePublishableResources(root, { skillPackages: ["support"] }, { waitForSettledWrites: () => file("skills/support/new.txt", "New asset.") })).rejects.toThrow("settled");
    await expect(capturePublishableResources(root, { skillPackages: ["support"] }, { waitForSettledWrites: async () => {
      await rm(path.join(root, "skills/support"), { recursive: true }); await symlink("/tmp", path.join(root, "skills/support"));
    } })).rejects.toThrow("real directories");
  });
  it("enforces byte, total, file, traversal and depth limits", async () => {
    await expect(capturePublishableResources(root, { skillPackages: ["support"] }, { limits: { maxFileBytes: 8 }, settleMs: 0 })).rejects.toThrow("size limit");
    await file("skills/support/asset.txt", "Asset");
    await expect(capturePublishableResources(root, { skillPackages: ["support"] }, { limits: { maxFiles: 1 }, settleMs: 0 })).rejects.toThrow("capture limits");
    await expect(capturePublishableResources(root, { skillPackages: ["support"] }, { limits: { maxTotalBytes: 8 }, settleMs: 0 })).rejects.toThrow("capture limits");
    await expect(capturePublishableResources(root, { skillPackages: ["support"] }, { limits: { maxDepth: 2 }, settleMs: 0 })).rejects.toThrow("unsafe");
    await expect(capturePublishableResources(root, {}, { limits: { maxFiles: 10000 } })).rejects.toThrow("server defaults");
    await rm(path.join(root, "skills/support/asset.txt"));
    for (let i = 0; i < 17; i++) await mkdir(path.join(root, "skills/support", "empty" + i));
    await expect(capturePublishableResources(root, { skillPackages: ["support"] }, { limits: { maxFiles: 1 }, settleMs: 0 })).rejects.toThrow("traversal limits");
  });
  it("requires complete nonoverlapping skill packages and validates immutable stored bytes", async () => {
    await file("skills/support/nested/SKILL.md", "nested");
    await expect(capture({ skillPackages: ["support", "support/nested"] })).rejects.toThrow("nonoverlapping");
    const snapshot = await capture(); const resource = snapshot.resources[0];
    expect(() => createTeamResourceSnapshot([{ ...resource, sha256: "a".repeat(64) }])).toThrow("reviewed hash");
    expect(() => validateTeamResourceSnapshot({ ...snapshot, manifestHash: "0".repeat(64) })).toThrow("reviewed content");
    expect(() => createTeamResourceSnapshot([{ ...resource, path: "skills/support/asset.txt" }])).toThrow("SKILL.md");
    expect(() => createTeamResourceSnapshot([resource, resource])).toThrow("Duplicate");
    expect(() => createTeamResourceSnapshot([{ ...resource, path: "skills/support/SKILL.md/child" }, resource])).toThrow("overlap");
    expect(() => createTeamResourceSnapshot([{ ...resource, encoding: "base64", content: "eA==\n", size: 1, sha256: resourceSha256("x") }])).toThrow("Noncanonical");
    expect(await readFile(path.join(root, "skills/support/SKILL.md"), "utf8")).toContain("# Support");
  });
});


describe("Hermes frozen publication review selection", () => {
  it("publishes selected exact packages, preserves unselected changes and requires explicit removals", async () => {
    await file("skills/support/scripts/run.py", "original script");
    await file("skills/obsolete/SKILL.md", "obsolete skill");
    await file("SOUL.md", "original role");
    const previous = await capturePublishableResources(root, { skillPackages: ["support", "obsolete"], includeRole: true }, { settleMs: 0 });
    await file("skills/support/SKILL.md", "improved support");
    await file("skills/support/scripts/run.py", "improved script");
    await file("skills/added/SKILL.md", "new shared procedure");
    await file("SOUL.md", "unselected role change");
    const captured = await capturePublishableResources(root, { skillPackages: ["support", "added"], includeRole: true }, { settleMs: 0 });
    const review = reviewTeamResourceChanges(previous, captured);
    expect(review.map(unit => [unit.packageId, unit.change])).toEqual([["SOUL.md", "changed"], ["skills/added", "added"], ["skills/obsolete", "removed"], ["skills/support", "changed"]]);
    const selected = selectTeamResourcePublication({ previous, captured, expectedPreviousHash: previous.manifestHash, expectedCapturedHash: captured.manifestHash,
      selectedKeys: ["skills/support", "skills/added"], removalKeys: [] });
    expect(selected.resources.find(resource => resource.path === "SOUL.md")!.content).toBe("original role");
    expect(selected.resources.find(resource => resource.path.endsWith("run.py"))!.content).toBe("improved script");
    expect(selected.resources.some(resource => resource.packageId === "skills/obsolete")).toBe(true);
    const removed = selectTeamResourcePublication({ previous, captured, expectedPreviousHash: previous.manifestHash, expectedCapturedHash: captured.manifestHash,
      selectedKeys: ["skills/support"], removalKeys: ["skills/obsolete"] });
    expect(removed.resources.some(resource => resource.packageId === "skills/obsolete")).toBe(false);
    expect(removed.resources.some(resource => resource.packageId === "skills/added")).toBe(false);
    await file("skills/support/SKILL.md", "learning after review");
    expect(removed.resources.find(resource => resource.path.endsWith("SKILL.md"))!.content).toBe("improved support");
  });
  it("rejects arbitrary removals, per-file picks, duplicate selections and stale review hashes", async () => {
    const previous = createTeamResourceSnapshot([]), captured = await capture();
    const input = { previous, captured, expectedPreviousHash: previous.manifestHash, expectedCapturedHash: captured.manifestHash, selectedKeys: ["skills/support"], removalKeys: [] };
    expect(() => selectTeamResourcePublication({ ...input, removalKeys: ["skills/support"] })).toThrow("captured review");
    expect(() => selectTeamResourcePublication({ ...input, removalKeys: ["skills/never-reviewed"] })).toThrow("captured review");
    expect(() => selectTeamResourcePublication({ ...input, selectedKeys: ["skills/support/SKILL.md"] })).toThrow("captured package");
    expect(() => selectTeamResourcePublication({ ...input, selectedKeys: ["skills/support", "skills/support"] })).toThrow("captured package");
    expect(() => selectTeamResourcePublication({ ...input, expectedCapturedHash: "stale" })).toThrow("stale");
    expect(() => selectTeamResourcePublication({ ...input, expectedPreviousHash: "stale" })).toThrow("stale");
    expect(() => selectTeamResourcePublication({ ...input, removalKeys: ["../auth"] })).toThrow("unsafe");
    const noChanges = { ...input, previous: captured, expectedPreviousHash: captured.manifestHash };
    expect(() => selectTeamResourcePublication(noChanges)).toThrow("captured package");
  });
});


describe("Publication package boundary changes", () => {
  it("rejects a captured nested package that overlaps the previous publication boundary", async () => {
    await file("skills/support/child/SKILL.md", "nested child");
    const previous = await capture();
    const captured = await capture({ skillPackages: ["support/child"] });
    expect(() => reviewTeamResourceChanges(previous, captured)).toThrow("boundaries overlap");
    expect(() => selectTeamResourcePublication({ previous, captured, expectedPreviousHash: previous.manifestHash, expectedCapturedHash: captured.manifestHash,
      selectedKeys: ["skills/support/child"], removalKeys: ["skills/support"] })).toThrow("boundaries overlap");
  });
});
