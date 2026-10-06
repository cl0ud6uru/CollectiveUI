import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { candidateBootstrap } from '@/docker-hermes/candidate-bundle';
import { runtimeKey, type Profile, type RuntimeDriver } from '@/docker-hermes/docker';
import { executeResourceHelper, type ResourceHelperRequest } from '@/docker-hermes/resource-helper';
import type { TeamCandidateConfig, TeamPublishableSnapshot, TeamResourceSelection, NativeResources } from '@/docker-hermes/types';
import type { ResourceUpdateReceipt, TeamResourceUpdatePlan } from '@/lib/hermes-team/updates';
import { HERMES_COMMIT } from '@/local-hermes/config';
import { stopOwnedGroup } from '@/local-hermes/process-group';
import type { RpcTransport } from '@/local-hermes/rpc';

const exec = promisify(execFile);
const launcher = path.resolve('tests/fixtures/hermes-team-active-gateway.py');

/** Actual pinned source/native processes in owned temporary volumes. No Docker/image proof. */
export class PinnedSourceRuntimeDriver implements RuntimeDriver {
  private active = new Set<string>();
  private children = new Map<string, Set<ChildProcessWithoutNullStreams>>();
  launches = 0;
  stderr = '';
  constructor(readonly root: string, readonly source: string, readonly python: string, readonly port: number) {}
  volume(owner: string) { return path.join(this.root, `native-volume-${runtimeKey(owner)}`); }
  home(owner: string, profile: string) { return path.join(this.volume(owner), 'profiles', profile); }
  private env() { return { NODE_ENV: 'test' as const, HERMES_SOURCE: this.source, PATH: '/usr/bin:/bin' }; }
  private async call(owner: string, op: string, profile = 'default', identity?: string) {
    const result = await exec(this.python, [launcher, op, this.volume(owner), profile, String(this.port), ...(identity ? [identity] : [])],
      { env: this.env(), timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(result.stdout);
  }
  async ensure(owner: string, stage: Parameters<RuntimeDriver['ensure']>[1]) {
    stage('checking_image'); // Broker phase name; this fixture verifies source, never claims an image check.
    await mkdir(this.volume(owner), { recursive: true, mode: 0o700 });
    await this.call(owner, 'initialize');
    this.active.add(owner); stage('checking_native');
  }
  async running(owner: string) { return this.active.has(owner); }
  async reopen(owner: string) { await this.call(owner, 'profiles'); this.active.add(owner); }
  async stop(owner: string) {
    this.active.delete(owner);
    const children = this.children.get(owner);
    if (children) await Promise.all([...children].map(async child => {
      if (child.pid) await stopOwnedGroup(child.pid);
    }));
  }
  async profiles(owner: string): Promise<Profile[]> { return this.call(owner, 'profiles'); }
  async create(): Promise<Profile> { throw new Error('Ordinary personal provisioning is outside this synthetic Team fixture'); }
  async createTeam(owner: string, name: string): Promise<Profile> { return this.call(owner, 'prepare', name); }
  async resources(owner: string, name: string, identity: string): Promise<NativeResources> { return this.call(owner, 'resources', name, identity); }
  transport(): RpcTransport { throw new Error('Ordinary personal transport is outside this synthetic Team fixture'); }
  candidateTransport(owner: string, profile: string, identity: string, input: TeamCandidateConfig): RpcTransport {
    // Preserve exact server-derived scopes and opaque tokens. Only the fixed origin
    // becomes this fixture's sole permitted loopback port; production keeps HTTPS.
    const local = (url: string) => `http://127.0.0.1:${this.port}${new URL(url).pathname}`;
    const config = { ...input, modelBaseUrls: Object.fromEntries(Object.entries(input.modelBaseUrls).map(([purpose, url]) => [purpose, local(url)])), toolUrl: local(input.toolUrl) } as TeamCandidateConfig;
    const bootstrap = candidateBootstrap(config);
    return { spawn: () => {
      if (!this.active.has(owner)) throw new Error('The synthetic owned runtime is stopped');
      this.launches++;
      const child = spawn(this.python, ['-u', launcher, 'gateway', this.volume(owner), profile, String(this.port), identity],
        { env: this.env(), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      const owned = this.children.get(owner) ?? new Set(); owned.add(child); this.children.set(owner, owned);
      child.once('exit', () => owned.delete(child));
      child.stderr.on('data', data => { this.stderr = (this.stderr + String(data)).slice(-32_000); });
      child.stdin.on('error', () => {}); child.stdin.write(bootstrap);
      return child;
    }, stop: () => this.stop(owner) };
  }
  private async helper(owner: string, input: ResourceHelperRequest) {
    if (await this.running(owner)) throw new Error('Stop all native writers before resource maintenance');
    const sourceRoot = path.join(this.root, 'fixture-image-metadata');
    await mkdir(sourceRoot, { recursive: true, mode: 0o700 });
    // Native source hashes were checked by every launch. This supplies only the
    // helper's filesystem marker; hosted Docker CI remains the actual image proof.
    await writeFile(path.join(sourceRoot, '.hermes_build_sha'), HERMES_COMMIT);
    const journalRoot = path.join(this.root, `protected-journal-${runtimeKey(owner)}`);
    await mkdir(journalRoot, { recursive: true, mode: 0o700 });
    return executeResourceHelper(input, { volumeRoot: this.volume(owner), sourceRoot, journalRoot });
  }
  async capturePublishableResources(owner: string, profile: string, identity: string, selection: TeamResourceSelection) {
    return await this.helper(owner, { operation: 'capture', profile, identity, selection }) as TeamPublishableSnapshot;
  }
  async inventoryPublishableResources(owner: string, profile: string, identity: string) {
    return await this.helper(owner, { operation: 'discover', profile, identity }) as TeamResourceSelection;
  }
  async inventoryMemberResources(owner: string, profile: string, identity: string, trackedPackageIds: readonly string[]) {
    return await this.helper(owner, { operation: 'inventory', profile, identity, trackedPackageIds }) as TeamPublishableSnapshot;
  }
  async applyTeamResourceUpdate(owner: string, profile: string, identity: string, operationId: string, plan: TeamResourceUpdatePlan, receipt?: ResourceUpdateReceipt) {
    return await this.helper(owner, { operation: 'apply', profile, identity, operationId, plan, receipt }) as ResourceUpdateReceipt;
  }
  async abortTeamResourceUpdate(owner: string, profile: string, identity: string, operationId: string, plan: TeamResourceUpdatePlan) {
    return await this.helper(owner, { operation: 'abort', profile, identity, operationId, plan }) as { aborted: true };
  }
  async close() { await Promise.all([...this.children.keys()].map(owner => this.stop(owner))); }
}
