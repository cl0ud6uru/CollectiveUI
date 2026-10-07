import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HERMES_COMMIT } from '@/local-hermes/config';
import { executeResourceHelper, RESOURCE_PROTOCOL_BYTES, RESOURCE_OUTPUT_BYTES } from '@/docker-hermes/resource-helper';
import { buildResourceHelper } from '@/docker-hermes/resource-bundle';
import { createTeamResourceSnapshot, resourceSha256, type TeamResource, type TeamResourceSnapshot } from '@/lib/hermes-team/resources';
import { applyTeamResourcePlan } from '@/lib/hermes-team/native-resources';
import { beginResourceUpdate, planTeamResourceUpdate } from '@/lib/hermes-team/updates';
let home: string, root: string, identity: string, roots: { volumeRoot: string; sourceRoot: string; journalRoot: string };
const profile = `cui-team-${'a'.repeat(32)}`;
const skill = (content: string): TeamResource => ({ path: 'skills/support/SKILL.md', packageId: 'skills/support', kind: 'skill', encoding: 'utf8', content, size: Buffer.byteLength(content), sha256: resourceSha256(content) });
const scope = { profile, get identity() { return identity; } };
const request = (operation: 'discover' | 'inventory') => ({ operation, ...scope, ...(operation === 'inventory' ? { trackedPackageIds: ['skills/support'] } : {}) });
const plan = async () => planTeamResourceUpdate({ installed: createTeamResourceSnapshot([skill('v1')]), release: createTeamResourceSnapshot([skill('v2')]), current: await executeResourceHelper(request('inventory'), roots) as TeamResourceSnapshot });
async function file(relative: string, content: string | Buffer) { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), content); }
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'hermes-volume-helper-'));
  roots = { volumeRoot: path.join(home, 'data'), sourceRoot: path.join(home, 'source'), journalRoot: path.join(home, 'protected') };
  root = path.join(roots.volumeRoot, 'profiles', profile);
  await mkdir(root, { recursive: true }); await mkdir(roots.sourceRoot); await mkdir(roots.journalRoot, { mode: 0o700 });
  const info = await stat(root, { bigint: true }); identity = `${info.dev}:${info.ino}`;
  await writeFile(path.join(roots.sourceRoot, '.hermes_build_sha'), HERMES_COMMIT);
  await file('.collectiveui-team-profile.json', JSON.stringify({ format: 1, inference: 'unverified' })); await file('gateway.parked', '');
  await file('skills/support/SKILL.md', 'v1');
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('bounded retained-volume helper', () => {
  it('discovers only publishable content and captures full scripts/assets without executing code', async () => {
    await file('skills/support/scripts/run.py', 'raise RuntimeError("This script must never execute")');
    await file('skills/support/assets/icon.bin', Buffer.from([0, 255, 1])); await file('documents/guide.md', 'shareable');
    await file('documents/auth.json', 'private'); await file('SOUL.md', 'shared role'); await file('memories/MEMORY.md', 'private memory');
    await file('auth.json', 'synthetic personal credential'); await file('sessions/history.json', 'private conversation');
    const selection = await executeResourceHelper(request('discover'), roots);
    expect(selection).toEqual({ skillPackages: ['support'], includeRole: true, documents: ['guide.md'] });
    const capture = await executeResourceHelper({ operation: 'capture', ...scope, selection }, roots) as TeamResourceSnapshot;
    expect(capture.resources.map(resource => resource.path)).toEqual(['SOUL.md', 'documents/guide.md', 'skills/support/SKILL.md', 'skills/support/assets/icon.bin', 'skills/support/scripts/run.py']);
    expect(capture.resources.find(resource => resource.path.endsWith('.bin'))?.encoding).toBe('base64');
    expect(await readFile(path.join(root, 'auth.json'), 'utf8')).toBe('synthetic personal credential');
  });
  it.each(['arbitrary-profile', 'wrong-inode', 'browser-path'])('refuses arbitrary paths and stale native identity: %s', async scenario => {
    const input = { operation: 'discover', ...scope, ...(scenario === 'arbitrary-profile' ? { profile: '../../personal' } : scenario === 'wrong-inode' ? { identity: '1:2' } : { path: '/tmp/personal' }) };
    await expect(executeResourceHelper(input, roots)).rejects.toThrow();
  });
  it('rejects symlink profiles and unsafe selectors; it never reads sibling profile history', async () => {
    const sibling = path.join(roots.volumeRoot, 'profiles', 'personal'); await mkdir(sibling); await writeFile(path.join(sibling, 'SOUL.md'), 'private');
    await expect(executeResourceHelper({ operation: 'capture', ...scope, selection: { documents: ['../personal/SOUL.md'] } }, roots)).rejects.toThrow();
    await rm(root, { recursive: true }); await symlink(sibling, root);
    await expect(executeResourceHelper(request('discover'), roots)).rejects.toThrow();
  });
  it.each(['.collectiveui-team-profile.json', 'gateway.parked'])('requires quarantine marker %s and exact pinned source', async marker => {
    await rm(path.join(root, marker)); await expect(executeResourceHelper(request('discover'), roots)).rejects.toThrow();
    await writeFile(path.join(roots.sourceRoot, '.hermes_build_sha'), 'unexpected'); await expect(executeResourceHelper({ operation: 'fence' }, roots)).rejects.toThrow();
  });
  it('uses only protected native receipts; supplied complete app receipt cannot skip writes', async () => {
    const update = await plan(), supplied = { ...beginResourceUpdate('release-1', update), status: 'complete', completedGroups: ['skills/support'] };
    const result = await executeResourceHelper({ operation: 'apply', ...scope, operationId: 'release-1', plan: update, receipt: supplied }, roots);
    expect(result).toMatchObject({ status: 'complete' }); expect(await readFile(path.join(root, 'skills/support/SKILL.md'), 'utf8')).toBe('v2');
    await file('skills/support/SKILL.md', 'later private learning');
    expect(await executeResourceHelper({ operation: 'apply', ...scope, operationId: 'release-1', plan: update }, roots)).toEqual(result);
    expect(await readFile(path.join(root, 'skills/support/SKILL.md'), 'utf8')).toBe('later private learning');
    expect(await executeResourceHelper({ operation: 'fence' }, roots)).toEqual({ settled: true });
    expect(await readdir(root)).not.toContain('release-1.json');
  });
  it('fences all read operations after partial writes and recovers the same immutable update', async () => {
    const update = await plan();
    await expect(applyTeamResourcePlan(root, 'interrupted', update, { journalRoot: path.join(roots.journalRoot, profile), checkpoint: async phase => { if (phase === 'parked') throw new Error('fixture crash'); } })).rejects.toThrow('fixture crash');
    for (const input of [{ operation: 'fence' }, request('discover'), request('inventory'), { operation: 'capture', ...scope, selection: {} }, { operation: 'abort', ...scope, operationId: 'interrupted', plan: update }])
      await expect(executeResourceHelper(input, roots)).rejects.toThrow();
    expect(await executeResourceHelper({ operation: 'apply', ...scope, operationId: 'interrupted', plan: update }, roots)).toMatchObject({ status: 'complete' });
    expect(await executeResourceHelper({ operation: 'fence' }, roots)).toEqual({ settled: true });
  });
  it('can discard an untouched stale attempt; malformed completed journals never lift the fence', async () => {
    const update = await plan(); await file('skills/support/SKILL.md', 'member correction');
    expect(await executeResourceHelper({ operation: 'apply', ...scope, operationId: 'stale', plan: update }, roots)).toMatchObject({ status: 'needs-attention' });
    expect(await executeResourceHelper({ operation: 'abort', ...scope, operationId: 'stale', plan: update }, roots)).toEqual({ aborted: true });
    expect(await executeResourceHelper({ operation: 'fence' }, roots)).toEqual({ settled: true });
    await writeFile(path.join(roots.journalRoot, profile, 'forged.json'), JSON.stringify({ format: 1, operationId: 'forged', planHash: 'a'.repeat(64), receipt: { status: 'complete' } }));
    await expect(executeResourceHelper({ operation: 'fence' }, roots)).rejects.toThrow();
  });
  it('inventories historical deleted boundaries without increasing snapshot file or byte bounds', async () => {
    const trackedPackageIds = [...Array.from({ length: 512 }, (_, i) => `skills/deleted-${i}`), 'skills/support'];
    const result = await executeResourceHelper({ operation: 'inventory', ...scope, trackedPackageIds }, roots) as TeamResourceSnapshot;
    expect(result.resources).toEqual([skill('v1')]);
    await expect(executeResourceHelper({ operation: 'inventory', ...scope, trackedPackageIds: Array.from({ length: 1025 }, (_, i) => `skills/deleted-${i}`) }, roots)).rejects.toThrow();
  });
  it('rejects unsafe update plans before profile writes', async () => {
    const update = await plan();
    await expect(executeResourceHelper({ operation: 'apply', ...scope, operationId: 'invalid', plan: { ...update, actions: [{ ...update.actions[0], packageId: '../auth.json' }] } }, roots)).rejects.toThrow();
    expect(await readFile(path.join(root, 'skills/support/SKILL.md'), 'utf8')).toBe('v1'); expect(await readdir(roots.journalRoot)).toEqual([]);
  });
  it('packages only application-owned code as a stable readable immutable module for pinned Node', async () => {
    const state = path.join(home, 'state'); await mkdir(state);
    const bundled = await buildResourceHelper(state); expect(await buildResourceHelper(state)).toBe(bundled);
    expect((await stat(bundled)).mode & 0o777).toBe(0o444);
    await promisify(execFile)(process.execPath, ['--check', bundled]);
    const output = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', 'const helper=await import(process.argv[1]);const input=JSON.parse(process.argv[2]);console.log(JSON.stringify(await helper.executeResourceHelper(input.request,input.roots)));', `file://${bundled}`, JSON.stringify({ request: request('discover'), roots })]);
    expect(JSON.parse(output.stdout)).toEqual({ skillPackages: ['support'], includeRole: false, documents: [] });
    expect(RESOURCE_PROTOCOL_BYTES).toBeGreaterThan(3 * 8 * 1024 * 1024 * 6); expect(RESOURCE_OUTPUT_BYTES).toBeGreaterThan(8 * 1024 * 1024 * 6);
    await chmod(bundled, 0o644); await writeFile(bundled, 'tampered'); await expect(buildResourceHelper(state)).rejects.toThrow('changed');
  });
});
