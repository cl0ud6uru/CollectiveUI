import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  assertSafeResourcePath, createTeamResourceSnapshot, DEFAULT_RESOURCE_LIMITS, resourceSha256,
  TeamResourceError, type ResourceSelection, type TeamResource, type TeamResourceSnapshot,
} from './resources';
import {
  beginResourceUpdate, nextResourceUpdateStep, recordResourceUpdateApplied, resourceGroupHash,
  type ResourceUpdateAction, type ResourceUpdateReceipt, type TeamResourceUpdatePlan,
} from './updates';
const fdPath = (fd: FileHandle, name?: string) => `/proc/self/fd/${fd.fd}${name ? '/' + name : ''}`;
const unsafe = (message = 'Native resource storage needs attention.'): never => { throw new TeamResourceError('unsafe-file', message); };
const fingerprint = (s: Awaited<ReturnType<FileHandle['stat']>>) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.nlink, s.mode].join(':');
async function rootHandle(root: string): Promise<FileHandle> {
  if (process.platform !== 'linux' || !path.isAbsolute(root) || await realpath(root) !== root) unsafe('A canonical server-derived Linux root is required.');
  return open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}
async function childDirectory(parent: FileHandle, name: string, create = false): Promise<FileHandle | null> {
  try { return await open(fdPath(parent, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unsafe('Native resource directories cannot be symlinks or special files.');
    if (!create) return null;
    await mkdir(fdPath(parent, name), { mode: 0o700 }); await parent.sync();
    return open(fdPath(parent, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  }
}
async function directoryAt<T>(root: FileHandle, relative: string, create: boolean, operation: (fd: FileHandle | null) => Promise<T>): Promise<T> {
  let current: FileHandle | null = root; const opened: FileHandle[] = [];
  try {
    for (const segment of relative.split('/').filter(Boolean)) {
      if (!current) break;
      current = await childDirectory(current, segment, create); if (current) opened.push(current);
    }
    return await operation(current);
  } finally { for (const fd of opened.reverse()) await fd.close(); }
}
interface Budget { entries: number; bytes: number; files: number }
const budget = (): Budget => ({ entries: 0, bytes: 0, files: 0 });
async function entries(fd: FileHandle, limit: Budget): Promise<string[]> {
  const result: string[] = [], stream = await opendir(fdPath(fd));
  for await (const entry of stream) {
    if (++limit.entries > DEFAULT_RESOURCE_LIMITS.maxFiles * 16) throw new TeamResourceError('limit', 'Native resource traversal exceeds limits.');
    result.push(entry.name);
  }
  return result.sort();
}
function allowed(resourcePath: string): boolean {
  try { assertSafeResourcePath(resourcePath); return true; } catch (error) {
    if (error instanceof TeamResourceError && error.code === 'unsafe-path') return false;
    throw error;
  }
}
async function fileResource(parent: FileHandle, name: string, resourcePath: string, packageId: string, limit: Budget): Promise<TeamResource> {
  const fd = await open(fdPath(parent, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.nlink !== 1) unsafe('Native resources cannot contain links or special files.');
    if (before.size > DEFAULT_RESOURCE_LIMITS.maxFileBytes || ++limit.files > DEFAULT_RESOURCE_LIMITS.maxFiles || (limit.bytes += before.size) > DEFAULT_RESOURCE_LIMITS.maxTotalBytes)
      throw new TeamResourceError('limit', 'Native resources exceed file or byte limits.');
    const buffer = Buffer.alloc(before.size + 1); let length = 0;
    while (length < buffer.length) { const read = await fd.read(buffer, length, buffer.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
    if (length !== before.size || fingerprint(before) !== fingerprint(await fd.stat())) throw new TeamResourceError('unstable', 'Native resource writes have not settled.');
    const bytes = buffer.subarray(0, length), text = bytes.toString('utf8');
    const encoding = Buffer.from(text).equals(bytes) && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) ? 'utf8' : 'base64';
    return { path: resourcePath, packageId, kind: packageId.startsWith('skills/') ? 'skill' : packageId === 'SOUL.md' ? 'role' : 'document',
      encoding, content: encoding === 'utf8' ? text : bytes.toString('base64'), size: bytes.length, sha256: resourceSha256(bytes) };
  } finally { await fd.close(); }
}
async function walkPackage(fd: FileHandle, prefix: string, packageId: string | null, limit: Budget, strict = false): Promise<TeamResource[]> {
  const result: TeamResource[] = [], before = await fd.stat();
  for (const name of await entries(fd, limit)) {
    const resourcePath = prefix + '/' + name;
    if (!allowed(resourcePath)) { if (strict) unsafe('A tracked package contains excluded private files; preserve and reconcile it.'); continue; }
    const stat = await lstat(fdPath(fd, name));
    if (stat.isDirectory()) {
      const child = await childDirectory(fd, name); if (!child) throw new TeamResourceError('unstable', 'Native resources changed during inventory.');
      try { result.push(...await walkPackage(child, resourcePath, packageId, limit, strict)); } finally { await child.close(); }
    } else result.push(await fileResource(fd, name, resourcePath, packageId ?? resourcePath, limit));
  }
  if (fingerprint(before) !== fingerprint(await fd.stat())) throw new TeamResourceError('unstable', 'Native resource directories changed during inventory.');
  return result;
}
async function inventory(root: FileHandle, tracked: readonly string[]): Promise<TeamResourceSnapshot> {
  const result: TeamResource[] = [], limit = budget();
  const findSkills = async (fd: FileHandle, prefix: string): Promise<void> => {
    const names = await entries(fd, limit);
    if (tracked.includes(prefix) || names.includes('SKILL.md')) { result.push(...await walkPackage(fd, prefix, prefix, limit)); return; }
    for (const name of names) {
      const resourcePath = prefix + '/' + name; if (!allowed(resourcePath)) continue;
      const stat = await lstat(fdPath(fd, name));
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) unsafe('Native skills cannot contain links or special files.');
      if (stat.isDirectory()) { const child = await childDirectory(fd, name); if (child) try { await findSkills(child, resourcePath); } finally { await child.close(); } }
    }
  };
  await directoryAt(root, 'skills', false, async fd => { if (fd) for (const name of await entries(fd, limit)) {
    const prefix = 'skills/' + name; if (!allowed(prefix)) continue;
    const stat = await lstat(fdPath(fd, name));
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) unsafe('Native skills cannot contain links or special files.');
    if (stat.isDirectory()) { const child = await childDirectory(fd, name); if (child) try { await findSkills(child, prefix); } finally { await child.close(); } }
  } });
  await directoryAt(root, 'documents', false, async fd => { if (fd) result.push(...await walkPackage(fd, 'documents', null, limit)); });
  try { await lstat(fdPath(root, 'SOUL.md')); result.push(await fileResource(root, 'SOUL.md', 'SOUL.md', 'SOUL.md', limit)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return createTeamResourceSnapshot(result, { requireCompleteSkills: false });
}
/** Full private inventory under a broker-held stopped-runtime lease. No member contents may reach an admin rollout. */
export async function inventoryMemberResources(profileRoot: string, trackedPackageIds: readonly string[] = []): Promise<TeamResourceSnapshot> {
  if (trackedPackageIds.length > DEFAULT_RESOURCE_LIMITS.maxFiles) throw new TeamResourceError('limit', 'Too many tracked packages.');
  for (const id of trackedPackageIds) assertSafeResourcePath(id);
  const root = await rootHandle(profileRoot);
  try {
    const first = await inventory(root, trackedPackageIds), second = await inventory(root, trackedPackageIds);
    if (first.manifestHash !== second.manifestHash) throw new TeamResourceError('unstable', 'Native resource writes have not settled.');
    return second;
  } finally { await root.close(); }
}
export async function inventoryPublishableResourceSelection(profileRoot: string): Promise<ResourceSelection> {
  const snapshot = await inventoryMemberResources(profileRoot);
  return { skillPackages: [...new Set(snapshot.resources.filter(resource => resource.kind === 'skill').map(resource => resource.packageId.slice('skills/'.length)))].sort(),
    includeRole: snapshot.resources.some(resource => resource.kind === 'role'), documents: snapshot.resources.filter(resource => resource.kind === 'document').map(resource => resource.path.slice('documents/'.length)).sort() };
}
async function groupResources(root: FileHandle, id: string, strict = true): Promise<readonly TeamResource[]> {
  assertSafeResourcePath(id);
  return directoryAt(root, path.posix.dirname(id), false, async parent => {
    if (!parent) return [];
    const name = path.posix.basename(id); let stat;
    try { stat = await lstat(fdPath(parent, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    if (id.startsWith('skills/')) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) unsafe();
      const directory = await childDirectory(parent, name); if (!directory) return [];
      try { return createTeamResourceSnapshot(await walkPackage(directory, id, id, budget(), strict), { requireCompleteSkills: false }).resources; } finally { await directory.close(); }
    }
    return createTeamResourceSnapshot([await fileResource(parent, name, id, id, budget())]).resources;
  });
}
interface NativeJournal { format: 1; operationId: string; planHash: string; receipt: ResourceUpdateReceipt; inFlight?: { packageId: string; stage: string; backup: string } }
async function readJournal(fd: FileHandle, name: string): Promise<NativeJournal | null> {
  let file: FileHandle;
  try { file = await open(fdPath(fd, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128 * 1024) unsafe('Unsafe resource operation journal.');
    const value = JSON.parse(await file.readFile('utf8')) as NativeJournal;
    if (value.format !== 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(value.operationId) || !/^[a-f0-9]{64}$/.test(value.planHash) || !value.receipt) unsafe('Invalid resource operation journal.');
    if (value.inFlight && (!allowed(value.inFlight.packageId) || !new RegExp(`^\\.collective-team-stage-${value.operationId}-[0-9]+$`).test(value.inFlight.stage)
      || !new RegExp(`^\\.collective-team-backup-${value.operationId}-[0-9]+$`).test(value.inFlight.backup))) unsafe('Invalid resource staging journal.');
    return value;
  } finally { await file.close(); }
}
async function saveJournal(fd: FileHandle, journal: NativeJournal): Promise<void> {
  const name = journal.operationId + '.json', temporary = journal.operationId + '.tmp';
  try {
    const stat = await lstat(fdPath(fd, temporary)); if (!stat.isFile() || stat.nlink !== 1) unsafe();
    await rm(fdPath(fd, temporary));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const file = await open(fdPath(fd, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(journal)); await file.sync(); } finally { await file.close(); }
  await rename(fdPath(fd, temporary), fdPath(fd, name)); await fd.sync();
}
/** journalRoot must be a helper-only broker volume, never mounted in a native/user container. */
export async function assertResourceUpdatesSettled(journalRoot: string): Promise<void> {
  const root = await rootHandle(journalRoot);
  try { for (const name of await entries(root, budget())) {
    if (!/^[A-Za-z0-9_-]{1,128}\.json$/.test(name)) continue;
    const journal = await readJournal(root, name);
    if (journal && (journal.inFlight || journal.receipt.status !== 'complete')) unsafe('A resource update is unfinished. Keep the native runtime stopped until it is recovered.');
  } } finally { await root.close(); }
}
async function removeStage(root: FileHandle, name: string): Promise<void> {
  try {
    const stat = await lstat(fdPath(root, name)); if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) unsafe('Unsafe resource staging path.');
    await rm(fdPath(root, name), { recursive: true }); await root.sync();
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
async function stageGroup(root: FileHandle, action: ResourceUpdateAction, stage: string): Promise<void> {
  await removeStage(root, stage);
  if (!action.teamResources.length) return;
  await mkdir(fdPath(root, stage), { mode: 0o700 });
  const stageFd = await childDirectory(root, stage); if (!stageFd) unsafe();
  try {
    for (const resource of action.teamResources) {
      const relative = resource.kind === 'skill' ? resource.path.slice(action.packageId.length + 1) : 'payload';
      await directoryAt(stageFd, path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative), true, async parent => {
        if (!parent) unsafe();
        const file = await open(fdPath(parent, path.posix.basename(relative)), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(Buffer.from(resource.content, resource.encoding === 'utf8' ? 'utf8' : 'base64')); await file.sync(); } finally { await file.close(); }
        await parent.sync();
      });
    }
    await stageFd.sync(); await root.sync();
  } finally { await stageFd.close(); }
}
const active = new Set<string>();
export async function applyTeamResourcePlan(profileRoot: string, operationId: string, plan: TeamResourceUpdatePlan, options: {
  journalRoot: string; receipt?: ResourceUpdateReceipt; checkpoint?: (phase: string) => Promise<void>;
}): Promise<ResourceUpdateReceipt> {
  if (active.has(profileRoot)) unsafe('Another resource update is active.');
  // Protected journal storage is separate; the broker owns its mount and enforces cross-process exclusion.
  if (!path.isAbsolute(options.journalRoot) || options.journalRoot === profileRoot || options.journalRoot.startsWith(profileRoot + path.sep)) unsafe('Resource journals must be outside the writable native profile.');
  // Application receipts are validated reports, never authority to skip native writes.
  beginResourceUpdate(operationId, plan, options.receipt);
  const freshReceipt = beginResourceUpdate(operationId, plan);
  if (await realpath(path.dirname(options.journalRoot)) !== path.dirname(options.journalRoot)) unsafe('Journal parent must be canonical protected storage.');
  try { await mkdir(options.journalRoot, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const root = await rootHandle(profileRoot); let journals: FileHandle;
  try { journals = await rootHandle(options.journalRoot); } catch (error) { await root.close(); throw error; }
  active.add(profileRoot);
  try {
    for (const name of await entries(journals, budget())) {
      if (name === operationId + '.json' || !/^[A-Za-z0-9_-]{1,128}\.json$/.test(name)) continue;
      const other = await readJournal(journals, name);
      if (other && (other.inFlight || other.receipt.status !== 'complete')) unsafe('Another resource update must be recovered first.');
    }
    let journal = await readJournal(journals, operationId + '.json');
    if (journal && (journal.operationId !== operationId || journal.planHash !== plan.planHash)) unsafe('Resource operation changed after it began.');
    const initial = beginResourceUpdate(operationId, plan, journal?.receipt ?? freshReceipt);
    journal ??= { format: 1, operationId, planHash: plan.planHash, receipt: initial };
    await saveJournal(journals, journal);
    for (;;) {
      if (journal.inFlight) {
        const flight = journal.inFlight, action = plan.actions.find(candidate => candidate.packageId === flight.packageId);
        if (!action || (action.action !== 'install' && action.action !== 'remove')) unsafe('Invalid resource recovery group.');
        const actual = resourceGroupHash(await groupResources(root, action.packageId));
        const backupExists = await lstat(fdPath(root, flight.backup)).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; });
        const backupResources = backupExists ? await backupGroupResources(root, action.packageId, flight.backup) : [];
        if (backupExists && resourceGroupHash(backupResources) !== action.beforeHash) unsafe('Resource backup changed during recovery.');
        if (actual === action.afterHash) {
          journal.receipt = recordResourceUpdateApplied(plan, journal.receipt, action.packageId, actual);
          await removeStage(root, flight.stage); await removeStage(root, flight.backup); delete journal.inFlight;
          await saveJournal(journals, journal); await options.checkpoint?.('recorded'); continue;
        }
        if (actual !== action.beforeHash && !(actual === resourceGroupHash([]) && backupExists)) {
          journal.receipt = { ...journal.receipt, status: 'needs-attention', blockedGroup: action.packageId };
          await saveJournal(journals, journal); return journal.receipt;
        }
        if (!backupExists) {
          await stageGroup(root, action, flight.stage); await options.checkpoint?.('staged');
          await directoryAt(root, path.posix.dirname(action.packageId), true, async parent => {
            if (!parent) unsafe();
            try { await rename(fdPath(parent, path.posix.basename(action.packageId)), fdPath(root, flight.backup)); await parent.sync(); await root.sync(); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || action.beforeHash !== resourceGroupHash([])) throw error; }
          });
          await options.checkpoint?.('parked');
        }
        if (action.teamResources.length) {
          const stageFd = await childDirectory(root, flight.stage); if (!stageFd) unsafe('Resource stage is missing during recovery.');
          let staged: readonly TeamResource[];
          try { staged = action.packageId.startsWith('skills/') ? await walkPackage(stageFd, action.packageId, action.packageId, budget(), true)
            : [await fileResource(stageFd, 'payload', action.packageId, action.packageId, budget())]; }
          finally { await stageFd.close(); }
          if (resourceGroupHash(createTeamResourceSnapshot(staged).resources) !== action.afterHash) unsafe('Staged resources changed after review.');
          await directoryAt(root, path.posix.dirname(action.packageId), true, async parent => {
            if (!parent) unsafe();
            if (action.packageId.startsWith('skills/')) await rename(fdPath(root, flight.stage), fdPath(parent, path.posix.basename(action.packageId)));
            else {
              const stageFd = await childDirectory(root, flight.stage); if (!stageFd) unsafe('Resource stage is missing during recovery.');
              try { await rename(fdPath(stageFd, 'payload'), fdPath(parent, path.posix.basename(action.packageId))); } finally { await stageFd.close(); }
            }
            await parent.sync(); await root.sync();
          });
        }
        await options.checkpoint?.('installed'); continue;
      }
      const hashes = new Map<string, string>();
      for (const action of plan.actions.filter(action => action.action === 'install' || action.action === 'remove'))
        if (!journal.receipt.completedGroups.includes(action.packageId)) hashes.set(action.packageId, resourceGroupHash(await groupResources(root, action.packageId)));
      const step = nextResourceUpdateStep(plan, journal.receipt, id => hashes.get(id)!);
      journal.receipt = step.receipt;
      if (step.kind !== 'apply') { await saveJournal(journals, journal); return journal.receipt; }
      const index = plan.actions.indexOf(step.action);
      for (const name of [`.collective-team-stage-${operationId}-${index}`, `.collective-team-backup-${operationId}-${index}`]) {
        const exists = await lstat(fdPath(root, name)).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; });
        if (exists) unsafe('Unowned resource staging collision.');
      }
      journal.inFlight = { packageId: step.action.packageId, stage: `.collective-team-stage-${operationId}-${index}`, backup: `.collective-team-backup-${operationId}-${index}` };
      await saveJournal(journals, journal); await options.checkpoint?.('intent');
    }
  } finally { active.delete(profileRoot); await root.close(); await journals.close(); }
}
async function backupGroupResources(root: FileHandle, packageId: string, name: string): Promise<readonly TeamResource[]> {
  if (packageId.startsWith('skills/')) {
    const fd = await childDirectory(root, name); if (!fd) return [];
    try { return createTeamResourceSnapshot(await walkPackage(fd, packageId, packageId, budget(), true), { requireCompleteSkills: false }).resources; } finally { await fd.close(); }
  }
  return createTeamResourceSnapshot([await fileResource(root, name, packageId, packageId, budget())]).resources;
}
