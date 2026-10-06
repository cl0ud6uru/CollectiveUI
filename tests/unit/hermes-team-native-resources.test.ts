import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTeamResourceSnapshot, resourceSha256, type TeamResource } from '@/lib/hermes-team/resources';
import { applyTeamResourcePlan, assertResourceUpdatesSettled, inventoryMemberResources, inventoryPublishableResourceSelection } from '@/lib/hermes-team/native-resources';
import { beginResourceUpdate, planTeamResourceUpdate } from '@/lib/hermes-team/updates';
let home: string, root: string, journals: string;
const skill = (content: string, file = 'SKILL.md', name = 'support'): TeamResource => ({ path: `skills/${name}/${file}`, packageId: `skills/${name}`, kind: 'skill', encoding: 'utf8', content, size: Buffer.byteLength(content), sha256: resourceSha256(content) });
async function file(relative: string, content: string) { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), content); }
beforeEach(async () => { home = await mkdtemp('/tmp/hermes-team-native-'); root = path.join(home, 'profile'); journals = path.join(home, 'journals'); await mkdir(root); await file('skills/support/SKILL.md', 'v1'); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const nextPlan = async (content = 'v2') => {
  const current = await inventoryMemberResources(root, ['skills/support']);
  return planTeamResourceUpdate({ installed: createTeamResourceSnapshot([skill('v1')]), release: createTeamResourceSnapshot([skill(content)]), current });
};
describe('Broker-derived private resource inventory', () => {
  it('discovers full independent packages, nested categories, documents and role while excluding private native state', async () => {
    await file('skills/category/learned/SKILL.md', 'learned'); await file('skills/support/scripts/run.py', 'script');
    await file('documents/shared.md', 'document'); await file('documents/auth.json', 'private'); await file('SOUL.md', 'role'); await file('memory/MEMORY.md', 'private');
    const snapshot = await inventoryMemberResources(root);
    expect(snapshot.resources.map(resource => resource.path)).toEqual(['SOUL.md', 'documents/shared.md', 'skills/category/learned/SKILL.md', 'skills/support/SKILL.md', 'skills/support/scripts/run.py']);
    expect(await inventoryPublishableResourceSelection(root)).toEqual({ skillPackages: ['category/learned', 'support'], includeRole: true, documents: ['shared.md'] });
  });
  it('keeps the tracked parent package boundary when its member deleted SKILL.md', async () => {
    await file('skills/support/child/SKILL.md', 'child'); await rm(path.join(root, 'skills/support/SKILL.md'));
    const tracked = await inventoryMemberResources(root, ['skills/support']);
    expect(tracked.resources).toMatchObject([{ path: 'skills/support/child/SKILL.md', packageId: 'skills/support' }]);
    expect((await inventoryMemberResources(root)).resources[0].packageId).toBe('skills/support/child');
  });
  it('rejects symlinks/hardlinks and bounded secret-like contents', async () => {
    await file('outside.md', 'private'); await symlink(path.join(root, 'outside.md'), path.join(root, 'skills/support/leak'));
    await expect(inventoryMemberResources(root)).rejects.toThrow(); await rm(path.join(root, 'skills/support/leak'));
    await link(path.join(root, 'outside.md'), path.join(root, 'skills/support/leak'));
    await expect(inventoryMemberResources(root)).rejects.toThrow('links'); await rm(path.join(root, 'skills/support/leak'));
    await file('skills/support/SKILL.md', 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789');
    await expect(inventoryMemberResources(root)).rejects.toThrow('credential-like');
  });
});
describe('Durable stopped-runtime filesystem application', () => {
  it('writes complete packages and retries completed work without erasing later member learning', async () => {
    const plan = await nextPlan();
    const result = await applyTeamResourcePlan(root, 'operation-1', plan, { journalRoot: journals });
    expect(result.status).toBe('complete'); expect(await readFile(path.join(root, 'skills/support/SKILL.md'), 'utf8')).toBe('v2');
    await assertResourceUpdatesSettled(journals);
    await file('skills/support/SKILL.md', 'later native learning');
    expect(await applyTeamResourcePlan(root, 'operation-1', plan, { journalRoot: journals })).toEqual(result);
    expect(await readFile(path.join(root, 'skills/support/SKILL.md'), 'utf8')).toBe('later native learning');
    expect((await readdir(root)).some(name => name.startsWith('.collective-team-'))).toBe(false);
  });
  it.each(['intent', 'staged', 'parked', 'installed', 'recorded'])('recovers actual filesystem interruption at %s without duplicate release application', async phase => {
    const plan = await nextPlan(); let failed = false;
    await expect(applyTeamResourcePlan(root, 'crash-operation', plan, { journalRoot: journals, checkpoint: async current => {
      if (!failed && current === phase) { failed = true; throw new Error('synthetic process interruption'); }
    } })).rejects.toThrow('synthetic process interruption');
    await expect(assertResourceUpdatesSettled(journals)).rejects.toThrow('unfinished');
    const result = await applyTeamResourcePlan(root, 'crash-operation', plan, { journalRoot: journals });
    expect(result.status).toBe('complete'); expect(await readFile(path.join(root, 'skills/support/SKILL.md'), 'utf8')).toBe('v2');
    await assertResourceUpdatesSettled(journals);
  });
  it('stops on new member writes after review, preserving their contents', async () => {
    const plan = await nextPlan(); await file('skills/support/SKILL.md', 'member correction after review');
    const result = await applyTeamResourcePlan(root, 'changed-operation', plan, { journalRoot: journals });
    expect(result.status).toBe('needs-attention'); expect(await readFile(path.join(root, 'skills/support/SKILL.md'), 'utf8')).toBe('member correction after review');
    await expect(assertResourceUpdatesSettled(journals)).rejects.toThrow('unfinished');
  });
  it('never replaces a package containing excluded private/auth/config files', async () => {
    const plan = await nextPlan(); await file('skills/support/auth.json', 'member credential fixture');
    await expect(applyTeamResourcePlan(root, 'private-operation', plan, { journalRoot: journals })).rejects.toThrow('excluded private');
    expect(await readFile(path.join(root, 'skills/support/auth.json'), 'utf8')).toBe('member credential fixture');
    expect(await readFile(path.join(root, 'skills/support/SKILL.md'), 'utf8')).toBe('v1');
  });
  it('checks staged bytes after a parked crash and refuses tampered stages, retaining the old package backup', async () => {
    const plan = await nextPlan();
    await expect(applyTeamResourcePlan(root, 'tamper-operation', plan, { journalRoot: journals, checkpoint: async phase => { if (phase === 'parked') throw new Error('crash'); } })).rejects.toThrow();
    const stage = (await readdir(root)).find(name => name.startsWith('.collective-team-stage-'))!;
    await writeFile(path.join(root, stage, 'SKILL.md'), 'unreviewed content');
    await expect(applyTeamResourcePlan(root, 'tamper-operation', plan, { journalRoot: journals })).rejects.toThrow('changed after review');
    const backup = (await readdir(root)).find(name => name.startsWith('.collective-team-backup-'))!;
    expect(await readFile(path.join(root, backup, 'SKILL.md'), 'utf8')).toBe('v1');
    await expect(assertResourceUpdatesSettled(journals)).rejects.toThrow('unfinished');
  });
  it('rejects journal paths inside the native profile, unsafe operation IDs and reused IDs for changed plans', async () => {
    const plan = await nextPlan();
    await expect(applyTeamResourcePlan(root, '../outside', plan, { journalRoot: journals })).rejects.toThrow('operation ID');
    await expect(applyTeamResourcePlan(root, 'inside', plan, { journalRoot: path.join(root, 'journals') })).rejects.toThrow('outside');
    await applyTeamResourcePlan(root, 'reused-id', plan, { journalRoot: journals });
    await expect(applyTeamResourcePlan(root, 'reused-id', await nextPlan('v3'), { journalRoot: journals })).rejects.toThrow('changed after');
  });
  it('recovers removal, file/role replacement and first install while leaving independently learned packages intact', async () => {
    await file('skills/learned/SKILL.md', 'member learning'); await file('SOUL.md', 'role1'); await file('documents/help.md', 'doc1');
    const current = await inventoryMemberResources(root);
    const installed = createTeamResourceSnapshot(current.resources.filter(resource => resource.packageId !== 'skills/learned'));
    const role = { path: 'SOUL.md', packageId: 'SOUL.md', kind: 'role' as const, encoding: 'utf8' as const, content: 'role2', size: 5, sha256: resourceSha256('role2') };
    const doc = { path: 'documents/help.md', packageId: 'documents/help.md', kind: 'document' as const, encoding: 'utf8' as const, content: 'doc2', size: 4, sha256: resourceSha256('doc2') };
    const plan = planTeamResourceUpdate({ installed, release: createTeamResourceSnapshot([role, doc, skill('added', 'SKILL.md', 'added')]), current });
    const result = await applyTeamResourcePlan(root, 'multi-group', plan, { journalRoot: journals });
    expect(result.status).toBe('complete'); expect(await readFile(path.join(root, 'SOUL.md'), 'utf8')).toBe('role2');
    expect(await readFile(path.join(root, 'documents/help.md'), 'utf8')).toBe('doc2'); expect(await readFile(path.join(root, 'skills/added/SKILL.md'), 'utf8')).toBe('added');
    expect(await readFile(path.join(root, 'skills/learned/SKILL.md'), 'utf8')).toBe('member learning');
    await expect(readFile(path.join(root, 'skills/support/SKILL.md'))).rejects.toThrow();
  });
});


describe("Protected native receipt authority", () => {
  it("does not initialize an absent protected journal from a forged completed application receipt", async () => {
    const plan = await nextPlan(), fresh = beginResourceUpdate('forged-complete', plan);
    const forged = { ...fresh, status: 'complete' as const, completedGroups: ['skills/support'] };
    const result = await applyTeamResourcePlan(root, 'forged-complete', plan, { journalRoot: journals, receipt: forged });
    expect(result.status).toBe('complete');
    expect(await readFile(path.join(root, 'skills/support/SKILL.md'), 'utf8')).toBe('v2');
  });
  it("does not skip a forged progressed prefix before the protected native journal exists", async () => {
    await file('skills/second/SKILL.md', 'old second');
    const current = await inventoryMemberResources(root), release = createTeamResourceSnapshot([skill('v2'), skill('new second', 'SKILL.md', 'second')]);
    const plan = planTeamResourceUpdate({ installed: current, release, current }), fresh = beginResourceUpdate('forged-prefix', plan);
    const forged = { ...fresh, completedGroups: [plan.actions[0].packageId] };
    await applyTeamResourcePlan(root, 'forged-prefix', plan, { journalRoot: journals, receipt: forged });
    expect(await readFile(path.join(root, 'skills/second/SKILL.md'), 'utf8')).toBe('new second');
    expect(await readFile(path.join(root, 'skills/support/SKILL.md'), 'utf8')).toBe('v2');
  });
});
