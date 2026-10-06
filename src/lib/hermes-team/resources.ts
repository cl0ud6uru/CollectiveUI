import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

export type TeamResourceKind = "skill" | "role" | "document";
export interface TeamResource {
  readonly path: string;
  readonly kind: TeamResourceKind;
  /** Whole skills are one publication/update unit, including their scripts and assets. */
  readonly packageId: string;
  readonly sha256: string;
  readonly encoding: "utf8" | "base64";
  readonly content: string;
  readonly size: number;
}
export interface TeamResourceSnapshot {
  readonly format: 1;
  readonly manifestHash: string;
  readonly resources: readonly TeamResource[];
}
export interface ResourceSelection {
  /** Relative directories inside skills/, each containing SKILL.md. */
  skillPackages?: readonly string[];
  includeRole?: boolean;
  /** Explicit relative files inside documents/. Never a whole profile clone. */
  documents?: readonly string[];
}
export interface ResourceLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxPathBytes: number;
  maxDepth: number;
}
export const DEFAULT_RESOURCE_LIMITS: Readonly<ResourceLimits> = Object.freeze({
  maxFiles: 256, maxFileBytes: 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024,
  maxPathBytes: 256, maxDepth: 16,
});
export class TeamResourceError extends Error {
  constructor(public readonly code: "unsafe-path" | "unsafe-file" | "secret-content" | "limit" | "unstable" | "invalid-manifest", message: string) {
    super(message); this.name = "TeamResourceError";
  }
}
const fail = (code: TeamResourceError["code"], message: string): never => { throw new TeamResourceError(code, message); };
export const resourceSha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** These names are never publishable, even when nested in an otherwise selected skill. */
function excludedSegment(segment: string): boolean {
  const value = segment.toLowerCase();
  return value.startsWith(".") || /^(?:auth|authentication|credentials?|secrets?|tokens?|cookies?|memory|memories|history|conversations?|sessions?|browser|logs?|caches?|config)(?:[._-]|$)/.test(value)
    || ["node_modules", "__pycache__", "venv", "target"].includes(value)
    || /\.(?:pem|key|p12|pfx|sqlite3?|db|log|pyc)$/.test(value);
}
/** Paths are protocol values, independent of a host filesystem's normalization rules. */
export function assertSafeResourcePath(value: string, limits: ResourceLimits = DEFAULT_RESOURCE_LIMITS): void {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > limits.maxPathBytes
    || value.includes("\\") || value.includes("%") || /[\x00-\x1f\x7f]/.test(value)
    || value.startsWith("/") || /^[A-Za-z]:/.test(value)) fail("unsafe-path", "Invalid publishable resource path");
  const segments = value.split("/");
  if (segments.length > limits.maxDepth || segments.some(segment => !segment || segment === "." || segment === ".." || excludedSegment(segment))) {
    fail("unsafe-path", "Excluded or unsafe publishable resource path");
  }
}
function limitsFor(input?: Partial<ResourceLimits>): ResourceLimits {
  const limits = { ...DEFAULT_RESOURCE_LIMITS, ...input };
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in DEFAULT_RESOURCE_LIMITS) || !Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_RESOURCE_LIMITS[key as keyof ResourceLimits]) fail("limit", "Resource limits must be positive and no larger than server defaults");
  }
  return limits;
}
function checkSecrets(bytes: Buffer): void {
  // Defense in depth only: content inspection cannot prove arbitrary prose is secret-free.
  const text = bytes.toString("utf8");
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(text)
    || /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/.test(text)
    || /(?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["']?)(?!\s*(?:\$\{|process\.env|os\.environ|<|YOUR_|REPLACE_|example|placeholder|changeme)\b)[A-Za-z0-9_+\/.=-]{16,}/i.test(text)) {
    fail("secret-content", "Selected resource contains credential-like content; review and remove it before publishing");
  }
}
export function resourceBytes(resource: TeamResource): Buffer {
  if (resource.encoding !== "utf8" && resource.encoding !== "base64") fail("invalid-manifest", "Unknown content encoding");
  if (typeof resource.content !== "string") fail("invalid-manifest", "Invalid resource content");
  const bytes = Buffer.from(resource.content, resource.encoding === "utf8" ? "utf8" : "base64");
  if (resource.encoding === "base64" && bytes.toString("base64") !== resource.content) fail("invalid-manifest", "Noncanonical base64 resource content");
  if (resource.encoding === "utf8" && bytes.toString("utf8") !== resource.content) fail("invalid-manifest", "Invalid UTF-8 resource content");
  return bytes;
}
function resourceFromBytes(resourcePath: string, kind: TeamResourceKind, packageId: string, bytes: Buffer): TeamResource {
  const text = bytes.toString("utf8");
  const encoding = Buffer.from(text, "utf8").equals(bytes) ? "utf8" : "base64";
  return { path: resourcePath, kind, packageId, sha256: resourceSha256(bytes), encoding, content: encoding === "utf8" ? text : bytes.toString("base64"), size: bytes.length };
}
function validateResource(resource: TeamResource, limits: ResourceLimits): void {
  assertSafeResourcePath(resource.path, limits);
  assertSafeResourcePath(resource.packageId, limits);
  const parts = resource.path.split("/");
  if (resource.kind === "skill") {
    if (!resource.packageId.startsWith("skills/") || resource.packageId.split("/").length < 2 || !resource.path.startsWith(resource.packageId + "/")) fail("invalid-manifest", "Invalid skill package grouping");
  } else if (resource.kind === "role") {
    if (resource.path !== "SOUL.md" || resource.packageId !== resource.path) fail("invalid-manifest", "Only SOUL.md is publishable role content");
  } else if (resource.kind === "document") {
    if (parts[0] !== "documents" || parts.length < 2 || resource.packageId !== resource.path) fail("invalid-manifest", "Invalid selected document");
  } else fail("invalid-manifest", "Invalid resource kind");
  if (!Number.isSafeInteger(resource.size) || resource.size < 0 || resource.size > limits.maxFileBytes || !/^[a-f0-9]{64}$/.test(resource.sha256)) fail("invalid-manifest", "Invalid resource size or hash");
  // Bound encoded strings before decoding untrusted persisted input.
  if (typeof resource.content !== "string") fail("invalid-manifest", "Invalid resource content");
  if (Buffer.byteLength(resource.content) > limits.maxFileBytes * 2) fail("limit", "Encoded resource exceeds size limit");
  const bytes = resourceBytes(resource);
  if (bytes.length !== resource.size || resourceSha256(bytes) !== resource.sha256) fail("invalid-manifest", "Resource content does not match its reviewed hash");
  checkSecrets(bytes);
}
function manifestHash(resources: readonly TeamResource[]): string {
  return resourceSha256(JSON.stringify(resources.map(({ path, kind, packageId, sha256, encoding, size }) => ({ path, kind, packageId, sha256, encoding, size }))));
}
/** Validates JSON read back from immutable revision storage; never evaluates package content. */
export function createTeamResourceSnapshot(resources: readonly TeamResource[], options: { limits?: Partial<ResourceLimits>; requireCompleteSkills?: boolean } = {}): TeamResourceSnapshot {
  const limits = limitsFor(options.limits);
  if (!Array.isArray(resources) || resources.length > limits.maxFiles) fail("limit", "Too many publishable files");
  const sorted = resources.map(resource => {
    if (!resource || typeof resource !== "object") fail("invalid-manifest", "Invalid resource");
    validateResource(resource, limits);
    return Object.freeze({ path: resource.path, kind: resource.kind, packageId: resource.packageId, sha256: resource.sha256, encoding: resource.encoding, content: resource.content, size: resource.size });
  }).sort((a, b) => compare(a.path, b.path));
  const seen = new Set<string>(); let total = 0;
  for (const resource of sorted) {
    if (seen.has(resource.path)) fail("invalid-manifest", "Duplicate resource path");
    if ([...seen].some(existing => existing.startsWith(resource.path + "/") || resource.path.startsWith(existing + "/"))) fail("invalid-manifest", "Resource paths overlap a file and directory");
    seen.add(resource.path); total += resource.size;
    if (total > limits.maxTotalBytes) fail("limit", "Publishable snapshot exceeds total size limit");
  }
  const packages = [...new Set(sorted.filter(resource => resource.kind === "skill").map(resource => resource.packageId))];
  if (packages.some((group, index) => packages.slice(index + 1).some(other => group.startsWith(other + "/") || other.startsWith(group + "/")))) fail("invalid-manifest", "Overlapping skill packages");
  if (options.requireCompleteSkills !== false && packages.some(group => !seen.has(group + "/SKILL.md"))) fail("invalid-manifest", "A skill package must include SKILL.md");
  return Object.freeze({ format: 1 as const, manifestHash: manifestHash(sorted), resources: Object.freeze(sorted) });
}
export function validateTeamResourceSnapshot(snapshot: TeamResourceSnapshot, options: { requireCompleteSkills?: boolean } = {}): TeamResourceSnapshot {
  if (!snapshot || snapshot.format !== 1) fail("invalid-manifest", "Unsupported snapshot format");
  const validated = createTeamResourceSnapshot(snapshot.resources, options);
  if (snapshot.manifestHash !== validated.manifestHash) fail("invalid-manifest", "Snapshot manifest does not match reviewed content");
  return validated;
}

interface Scan { resources: TeamResource[]; fingerprints: string[] }
const fdPath = (handle: FileHandle, child?: string) => `/proc/self/fd/${handle.fd}${child ? "/" + child : ""}`;
const statFingerprint = (stat: Awaited<ReturnType<FileHandle["stat"]>>) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode, stat.nlink].join(":");
async function openDirectory(parent: FileHandle, segment: string): Promise<FileHandle> {
  try { return await open(fdPath(parent, segment), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch { return fail("unsafe-file", "Selected source must contain only real directories and files"); }
}
async function withDirectory<T>(root: FileHandle, relative: string, operation: (directory: FileHandle) => Promise<T>): Promise<T> {
  const handles: FileHandle[] = []; let directory = root;
  try {
    for (const segment of relative.split("/").filter(Boolean)) { directory = await openDirectory(directory, segment); handles.push(directory); }
    return await operation(directory);
  } finally { for (const handle of handles.reverse()) await handle.close(); }
}
async function readResource(directory: FileHandle, name: string, resourcePath: string, kind: TeamResourceKind, packageId: string, scan: Scan, limits: ResourceLimits): Promise<void> {
  let handle: FileHandle;
  try { handle = await open(fdPath(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return fail("unsafe-file", "Selected source must contain only real files"); }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) fail("unsafe-file", "Symlinks, hardlinks and special files are not publishable");
    if (before.size > limits.maxFileBytes) fail("limit", "Selected file exceeds size limit");
    // A fixed-size read bounds allocation even if a native writer grows the file concurrently.
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
    const after = await handle.stat();
    if (statFingerprint(before) !== statFingerprint(after) || length !== before.size) fail("unstable", "Native resource writes have not settled; capture again when idle");
    const content = bytes.subarray(0, length); checkSecrets(content);
    if (scan.resources.length >= limits.maxFiles || scan.resources.reduce((total, item) => total + item.size, 0) + content.length > limits.maxTotalBytes) fail("limit", "Publishable snapshot exceeds capture limits");
    scan.resources.push(resourceFromBytes(resourcePath, kind, packageId, content));
    scan.fingerprints.push(resourcePath + ":" + statFingerprint(after));
  } finally { await handle.close(); }
}
async function scanSelected(root: FileHandle, selection: Required<ResourceSelection>, limits: ResourceLimits): Promise<Scan> {
  const scan: Scan = { resources: [], fingerprints: [] }; let entryCount = 0;
  const walk = async (directory: FileHandle, resourcePath: string, packageId: string): Promise<void> => {
    const before = await directory.stat();
    const entries = [];
    const iterator = await opendir(fdPath(directory));
    for await (const entry of iterator) {
      if (++entryCount > limits.maxFiles * 16) fail("limit", "Selected directories exceed traversal limits");
      entries.push(entry);
    }
    for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
      if (excludedSegment(entry.name)) continue;
      const childPath = resourcePath + "/" + entry.name; assertSafeResourcePath(childPath, limits);
      if (entry.isDirectory()) { const child = await openDirectory(directory, entry.name); try { await walk(child, childPath, packageId); } finally { await child.close(); } }
      else await readResource(directory, entry.name, childPath, "skill", packageId, scan, limits);
    }
    const after = await directory.stat();
    if (statFingerprint(before) !== statFingerprint(after)) fail("unstable", "Native resource directories changed during capture");
    scan.fingerprints.push(resourcePath + ":" + statFingerprint(after));
  };
  for (const skill of selection.skillPackages) {
    const packageId = "skills/" + skill;
    await withDirectory(root, packageId, directory => walk(directory, packageId, packageId));
    if (!scan.resources.some(resource => resource.path === packageId + "/SKILL.md")) fail("invalid-manifest", "Selected skill package is missing SKILL.md");
  }
  if (selection.includeRole) await readResource(root, "SOUL.md", "SOUL.md", "role", "SOUL.md", scan, limits);
  for (const document of selection.documents) {
    const resourcePath = "documents/" + document;
    await withDirectory(root, path.posix.dirname(resourcePath), directory => readResource(directory, path.posix.basename(resourcePath), resourcePath, "document", resourcePath, scan, limits));
  }
  return scan;
}
/**
 * Linux volume-helper boundary. profileRoot MUST be server-derived; hold the native runtime's
 * idle/maintenance lease across this call. Two equal scans detect unsettled writes but cannot
 * replace that lease. Held directory descriptors prevent parent-directory symlink races.
 */
export async function capturePublishableResources(profileRoot: string, requested: ResourceSelection, options: { limits?: Partial<ResourceLimits>; settleMs?: number; waitForSettledWrites?: () => Promise<void> } = {}): Promise<TeamResourceSnapshot> {
  const limits = limitsFor(options.limits);
  const settleMs = options.settleMs ?? 50;
  if (!Number.isSafeInteger(settleMs) || settleMs < 0 || settleMs > 5000) fail("limit", "Invalid settle interval");
  if (!requested || typeof requested !== "object"
    || (requested.skillPackages !== undefined && !Array.isArray(requested.skillPackages))
    || (requested.documents !== undefined && !Array.isArray(requested.documents))
    || (requested.includeRole !== undefined && typeof requested.includeRole !== "boolean")) fail("invalid-manifest", "Invalid resource selection");
  const selection: Required<ResourceSelection> = { skillPackages: [...new Set(requested.skillPackages ?? [])].sort(compare), includeRole: requested.includeRole ?? false, documents: [...new Set(requested.documents ?? [])].sort(compare) };
  for (const skill of selection.skillPackages) { if (typeof skill !== "string") fail("unsafe-path", "Invalid skill package selection"); assertSafeResourcePath("skills/" + skill, limits); }
  for (const document of selection.documents) { if (typeof document !== "string") fail("unsafe-path", "Invalid document selection"); assertSafeResourcePath("documents/" + document, limits); }
  if (selection.skillPackages.length + selection.documents.length + Number(selection.includeRole) > limits.maxFiles) fail("limit", "Too many selected resources");
  if (selection.skillPackages.some((group, index) => selection.skillPackages.slice(index + 1).some(other => other.startsWith(group + "/") || group.startsWith(other + "/")))) fail("unsafe-path", "Select nonoverlapping whole skill packages");
  if (process.platform !== "linux" || !path.isAbsolute(profileRoot) || await realpath(profileRoot) !== profileRoot) fail("unsafe-path", "Capture requires a canonical server-derived Linux profile root");
  const source = await lstat(profileRoot);
  if (!source.isDirectory() || source.isSymbolicLink()) fail("unsafe-file", "Profile root must be a real directory");
  const root = await open(profileRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const identity = await root.stat();
    if (identity.dev !== source.dev || identity.ino !== source.ino) fail("unstable", "Profile root changed during capture");
    const first = await scanSelected(root, selection, limits);
    if (options.waitForSettledWrites) await options.waitForSettledWrites();
    else if (settleMs) await new Promise(resolve => setTimeout(resolve, settleMs));
    const second = await scanSelected(root, selection, limits);
    if (JSON.stringify(first.fingerprints) !== JSON.stringify(second.fingerprints)
      || createTeamResourceSnapshot(first.resources, { limits }).manifestHash !== createTeamResourceSnapshot(second.resources, { limits }).manifestHash) fail("unstable", "Native resource writes have not settled; capture again when idle");
    const currentRoot = await lstat(profileRoot);
    if (currentRoot.dev !== source.dev || currentRoot.ino !== source.ino || !currentRoot.isDirectory() || currentRoot.isSymbolicLink()) fail("unstable", "Profile root changed during capture");
    return createTeamResourceSnapshot(second.resources, { limits });
  } finally { await root.close(); }
}

export interface TeamResourceReviewUnit {
  readonly packageId: string;
  readonly change: "added" | "changed" | "removed";
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly previousResources: readonly TeamResource[];
  readonly capturedResources: readonly TeamResource[];
}
/** Package boundaries cannot move across a revision while overlapping member resources remain. */
export function assertCompatibleResourcePackages(...snapshots: readonly TeamResourceSnapshot[]): void {
  const packages = [...new Set(snapshots.flatMap(snapshot => snapshot.resources.map(resource => resource.packageId)))].sort(compare);
  if (packages.some((group, index) => packages.slice(index + 1).some(other => other.startsWith(group + "/") || group.startsWith(other + "/"))))
    fail("invalid-manifest", "Resource package boundaries overlap across snapshots; reconcile them before publishing or updating");
}
export const resourcePackageHash = (resources: readonly TeamResource[]): string => resourceSha256(JSON.stringify([...resources].sort((a, b) => compare(a.path, b.path)).map(resource => [resource.path, resource.sha256])));
function snapshotPackages(snapshot: TeamResourceSnapshot): Map<string, readonly TeamResource[]> {
  const packages = new Map<string, TeamResource[]>();
  for (const resource of snapshot.resources) packages.set(resource.packageId, [...packages.get(resource.packageId) ?? [], resource]);
  return packages;
}
/** Review units contain exact captured bytes; later profile learning is a different draft. */
export function reviewTeamResourceChanges(previous: TeamResourceSnapshot, captured: TeamResourceSnapshot): readonly TeamResourceReviewUnit[] {
  const validatedPrevious = validateTeamResourceSnapshot(previous), validatedCaptured = validateTeamResourceSnapshot(captured);
  assertCompatibleResourcePackages(validatedPrevious, validatedCaptured);
  const before = snapshotPackages(validatedPrevious);
  const after = snapshotPackages(validatedCaptured);
  const units: TeamResourceReviewUnit[] = [];
  for (const packageId of [...new Set([...before.keys(), ...after.keys()])].sort(compare)) {
    const previousResources = before.get(packageId) ?? [], capturedResources = after.get(packageId) ?? [];
    const beforeHash = resourcePackageHash(previousResources), afterHash = resourcePackageHash(capturedResources);
    if (beforeHash === afterHash) continue;
    units.push(Object.freeze({ packageId, change: !previousResources.length ? "added" : !capturedResources.length ? "removed" : "changed",
      beforeHash, afterHash, previousResources: Object.freeze([...previousResources]), capturedResources: Object.freeze([...capturedResources]) }));
  }
  return Object.freeze(units);
}
/**
 * Merge only explicitly approved review units into the expected previous publication. Server
 * code must also compare the immutable base revision under its publish transaction lock.
 */
export function selectTeamResourcePublication(input: {
  previous: TeamResourceSnapshot;
  captured: TeamResourceSnapshot;
  expectedPreviousHash: string;
  expectedCapturedHash: string;
  selectedKeys: readonly string[];
  removalKeys: readonly string[];
}): TeamResourceSnapshot {
  const previous = validateTeamResourceSnapshot(input.previous), captured = validateTeamResourceSnapshot(input.captured);
  if (previous.manifestHash !== input.expectedPreviousHash || captured.manifestHash !== input.expectedCapturedHash) fail("invalid-manifest", "Publication review is stale; capture and review again");
  if (!Array.isArray(input.selectedKeys) || !Array.isArray(input.removalKeys) || input.selectedKeys.length + input.removalKeys.length > DEFAULT_RESOURCE_LIMITS.maxFiles) fail("limit", "Invalid publication selection");
  const units = new Map(reviewTeamResourceChanges(previous, captured).map(unit => [unit.packageId, unit]));
  const selected = new Set<string>();
  for (const key of input.selectedKeys) {
    assertSafeResourcePath(key);
    if (selected.has(key) || !units.has(key) || units.get(key)!.change === "removed") fail("invalid-manifest", "Selected publication item is not an added or changed captured package");
    selected.add(key);
  }
  const removed = new Set<string>();
  for (const key of input.removalKeys) {
    assertSafeResourcePath(key);
    if (removed.has(key) || selected.has(key) || !units.has(key) || units.get(key)!.change !== "removed") fail("invalid-manifest", "Selected removal is not in this captured review");
    removed.add(key);
  }
  return createTeamResourceSnapshot([
    ...previous.resources.filter(resource => !selected.has(resource.packageId) && !removed.has(resource.packageId)),
    ...captured.resources.filter(resource => selected.has(resource.packageId)),
  ]);
}
