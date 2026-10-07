/** Fixed, bundled entrypoint for a stopped retained volume. No native or skill code is imported. */
import { constants } from 'node:fs';
import { chmod, chown, lstat, open, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { HERMES_COMMIT } from '../local-hermes/config';
import { capturePublishableResources, validateTeamResourceSnapshot } from '../lib/hermes-team/resources';
import { inventoryMemberResources, inventoryPublishableResourceSelection, applyTeamResourcePlan, assertResourceUpdatesSettled, abortUnstartedResourceUpdate } from '../lib/hermes-team/native-resources';
import type { TeamResourceUpdatePlan, ResourceUpdateReceipt } from '../lib/hermes-team/updates';
import type { TeamResourceSelection } from './types';

export const RESOURCE_PROTOCOL_BYTES = 160 * 1024 * 1024;
export const RESOURCE_OUTPUT_BYTES = 64 * 1024 * 1024;
export type ResourceHelperRequest =
  | { operation: 'fence' }
  | { operation: 'initialize-journals' }
  | { operation: 'capture'; profile: string; identity: string; selection: TeamResourceSelection }
  | { operation: 'discover'; profile: string; identity: string }
  | { operation: 'inventory'; profile: string; identity: string; trackedPackageIds: readonly string[] }
  | { operation: 'abort'; profile: string; identity: string; operationId: string; plan: TeamResourceUpdatePlan }
  | { operation: 'apply'; profile: string; identity: string; operationId: string; plan: TeamResourceUpdatePlan; receipt?: ResourceUpdateReceipt };
type HelperRoots = { volumeRoot: string; sourceRoot: string; journalRoot: string };
const roots: HelperRoots = { volumeRoot: '/opt/data', sourceRoot: '/opt/hermes', journalRoot: '/run/collective-team-updates' };
const teamName = /^cui-team-[a-f0-9]{32}$/;
class HelperError extends Error {}
function refuse(): never { throw new HelperError('Resource helper refused the request.'); }
function request(input: unknown): ResourceHelperRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) refuse();
  const value = input as Record<string, unknown>;
  const keys = value.operation === 'fence' || value.operation === 'initialize-journals' ? ['operation'] : value.operation === 'capture' ? ['operation', 'profile', 'identity', 'selection']
    : value.operation === 'discover' ? ['operation', 'profile', 'identity'] : value.operation === 'inventory' ? ['operation', 'profile', 'identity', 'trackedPackageIds']
      : value.operation === 'abort' ? ['operation', 'profile', 'identity', 'operationId', 'plan'] : value.operation === 'apply' ? ['operation', 'profile', 'identity', 'operationId', 'plan', 'receipt'] : refuse();
  if (Object.keys(value).some(key => !keys.includes(key))) refuse();
  if (value.operation !== 'fence' && value.operation !== 'initialize-journals' && (typeof value.profile !== 'string' || !teamName.test(value.profile)
    || typeof value.identity !== 'string' || !/^\d+:\d+$/.test(value.identity))) refuse();
  if (value.operation === 'inventory' && (!Array.isArray(value.trackedPackageIds) || value.trackedPackageIds.length > 1024 || value.trackedPackageIds.some(id => typeof id !== 'string'))) refuse();
  if (['apply', 'abort'].includes(String(value.operation)) && (typeof value.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.operationId))) refuse();
  return value as ResourceHelperRequest;
}
async function boundedFile(directory: string, name: string): Promise<string> {
  const handle = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) refuse();
    const bytes = Buffer.alloc(stat.size + 1); const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== stat.size) refuse();
    return bytes.subarray(0, read.bytesRead).toString('utf8');
  } finally { await handle.close(); }
}
async function profileRoot(input: Exclude<ResourceHelperRequest, { operation: 'fence' | 'initialize-journals' }>, root: HelperRoots): Promise<string> {
  const profile = path.join(root.volumeRoot, 'profiles', input.profile);
  if (await realpath(profile) !== profile) refuse();
  const stat = await lstat(profile, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || `${stat.dev}:${stat.ino}` !== input.identity) refuse();
  const marker = JSON.parse(await boundedFile(profile, '.collectiveui-team-profile.json'));
  if (!marker || marker.format !== 1 || marker.inference !== 'unverified' || Object.keys(marker).length !== 2) refuse();
  await boundedFile(profile, 'gateway.parked');
  return profile;
}
async function settledIfPresent(journalRoot: string) {
  try { await lstat(journalRoot); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  await assertResourceUpdatesSettled(journalRoot);
}
/** Options exist for synthetic filesystem fixtures; the CLI always uses fixed container roots. */
export async function executeResourceHelper(input: unknown, root: HelperRoots = roots): Promise<unknown> {
  const selected = request(input);
  if (process.platform !== 'linux' || (await readFile(path.join(root.sourceRoot, '.hermes_build_sha'), 'utf8')).trim() !== HERMES_COMMIT) refuse();
  if (selected.operation === 'initialize-journals') {
    if (await realpath(root.journalRoot) !== root.journalRoot) refuse();
    const stat = await lstat(root.journalRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) refuse();
    if (stat.uid === 10000 && stat.gid === 10000 && (stat.mode & 0o777) === 0o700) return { initialized: true };
    if (stat.uid !== 0 || stat.gid !== 0 || (await readdir(root.journalRoot)).length) refuse();
    await chmod(root.journalRoot, 0o700); await chown(root.journalRoot, 10000, 10000);
    return { initialized: true };
  }
  if (selected.operation === 'fence') {
    if (await realpath(root.journalRoot) !== root.journalRoot) refuse();
    const entries = await readdir(root.journalRoot, { withFileTypes: true });
    if (entries.length > 64) refuse();
    for (const entry of entries) {
      if (!entry.isDirectory() || !teamName.test(entry.name)) refuse();
      await assertResourceUpdatesSettled(path.join(root.journalRoot, entry.name));
    }
    return { settled: true };
  }
  const home = await profileRoot(selected, root), journalRoot = path.join(root.journalRoot, selected.profile);
  let result: unknown;
  if (selected.operation === 'capture') {
    await settledIfPresent(journalRoot);
    result = validateTeamResourceSnapshot(await capturePublishableResources(home, selected.selection));
  } else if (selected.operation === 'discover') {
    await settledIfPresent(journalRoot);
    result = await inventoryPublishableResourceSelection(home);
  } else if (selected.operation === 'inventory') {
    await settledIfPresent(journalRoot);
    result = validateTeamResourceSnapshot(await inventoryMemberResources(home, selected.trackedPackageIds), { requireCompleteSkills: false });
  } else if (selected.operation === 'abort') {
    result = await abortUnstartedResourceUpdate(home, selected.operationId, selected.plan, { journalRoot });
  } else {
    result = await applyTeamResourcePlan(home, selected.operationId, selected.plan, { journalRoot, receipt: selected.receipt });
  }
  await profileRoot(selected, root);
  return result;
}
async function main() {
  let size = 0; const chunks: string[] = [], decoder = new StringDecoder('utf8');
  for await (const part of process.stdin) {
    const chunk = Buffer.from(part); size += chunk.length; if (size > RESOURCE_PROTOCOL_BYTES) refuse(); chunks.push(decoder.write(chunk));
  }
  chunks.push(decoder.end()); const input = chunks.join(''); chunks.length = 0;
  const value = await executeResourceHelper(JSON.parse(input));
  const output = JSON.stringify({ ok: true, value });
  if (Buffer.byteLength(output) > RESOURCE_OUTPUT_BYTES) refuse();
  process.stdout.write(output);
}
if (process.argv[2] === '--run') void main().catch(() => {
  // Filesystem/content/native exceptions can contain private paths or secrets.
  process.stdout.write(JSON.stringify({ ok: false, error: 'resource_refused' })); process.exitCode = 1;
});
