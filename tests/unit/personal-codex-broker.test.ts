import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { BrokerConfig, PersonalCodexDriver } from '@/personal-codex/docker';
import { EnrollmentJournal } from '@/personal-codex/enrollment';
import { startPersonalBroker } from '@/personal-codex/server';
import { LOCAL_ORIGIN, socketFetch } from '@/lib/local-hermes/client';
import { tokenFingerprint } from '@/personal-codex/contracts';
import { CodexClient } from '@/lib/codex/client';

vi.mock('server-only', () => ({}));

const AUTH_SENTINEL = 'fixture-only-native-auth-sentinel';
const NATIVE_ERROR_SENTINEL = 'fixture-only-native-error-sentinel';
const RPC_FIXTURE = String.raw`
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
let loginCount = 0;
let connected = process.env.ACCOUNT_MODE === 'connected';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const log = method => appendFileSync(process.env.RPC_LOG, method + '\n');
const paramsLog = m => appendFileSync(process.env.RPC_LOG + '.params', JSON.stringify({method:m.method, params:m.params}) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method) { log(m.method); paramsLog(m); }
  if (m.method === 'initialized' && m.id === undefined) return;
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'codex_cli_rs/0.163.0-alpha.2 (Linux)' } });
  else if (m.method === 'config/read') send({id:m.id,result:{config:{model_provider:process.env.WRONG_NATIVE_MODE==='1'?'openai_chatgpt_plan':'openai',forced_login_method:'chatgpt'}}});
  else if (m.method === 'command/exec') send({ id: m.id, result: process.env.FAIL_PROBE === '1'
    ? { exitCode: 0, stdout: 'unsafe-probe-output', stderr: 'fixture-only-native-error-sentinel' }
    : { exitCode: 0, stdout: 'collective-codex-sandbox-ready', stderr: '' } });
  else if (m.method === 'account/read') send({ id: m.id, result: connected
    ? { account: { type: 'chatgpt', email: process.env.OWNER + '@test.invalid', planType: 'business', accessToken: 'fixture-only-native-auth-sentinel' },
        workspaceRouting: { chatgptAccountId: 'workspace-' + process.env.OWNER, backendOrigin: 'https://private.native.invalid', accountRoutingOverride: 'us', token: 'fixture-only-native-auth-sentinel' },
        ignoredNativeError: 'fixture-only-native-error-sentinel' }
    : { account: null, workspaceRouting: null, ignoredNativeError: 'fixture-only-native-error-sentinel' } });
  else if (m.method === 'account/login/start') {
    loginCount++;
    if (process.env.EMIT_STALE === '1') send({ method: 'account/login/completed', params: { loginId: 'stale-login-id', success: true } });
    if (process.env.COMPLETE_LOGIN) {
      connected = process.env.COMPLETE_LOGIN === 'success';
      send({method:'account/login/completed',params:{loginId:process.env.OWNER+'-login-'+loginCount,success:connected,error:'fixture-only-native-auth-sentinel'}});
    }
    send({ id: m.id, result: { type: 'chatgptDeviceCode', loginId: process.env.OWNER + '-login-' + loginCount,
      verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'CODE-' + process.env.OWNER.toUpperCase() } });
  } else if (m.method === 'account/login/cancel' && process.env.COMPLETE_DURING_CANCEL === '1') {
    connected = true;
    send({ method: 'account/login/completed', params: { loginId: process.env.OWNER + '-login-' + loginCount, success: true } });
    setTimeout(() => send({ id: m.id, result: { status: 'notFound' } }), 30);
  } else if (m.method === 'account/logout') { connected = false; send({ id: m.id, result: {} }); }
  else if (m.method === 'account/login/cancel') send({ id: m.id, result: {} });
  else send({ id: m.id, result: {} });
});
`;

class FixtureDriver extends PersonalCodexDriver {
  readonly ensured: string[] = [];
  readonly retainedStarts: string[] = [];
  readonly bridged: string[] = [];
  readonly children = new Set<ChildProcessWithoutNullStreams>();
  readonly provisioned = new Set<string>();
  readonly stopped = new Set<string>();
  readonly pauses: boolean[] = [];
  computerEnabled = false;
  failProbe = false;
  wrongNativeMode = false;
  connectedAccount = false;
  emitStaleCompletion = false;
  completeDuringCancel = false;
  completeLogin: 'success' | 'failure' | undefined;
  failClearToken = false;
  readonly tokens = new Map<string, string>();

  constructor(owners: string[], socketPath: string, readonly logDir: string) {
    super(BrokerConfig.parse({
      socketPath, image: `collectiveui/personal-codex@sha256:${'a'.repeat(64)}`,
      namespace: 'cui-codex-test', owners,
    }));
  }

  override name(owner: string) { return super.name(owner); }
  override async inspect(owner: string) {
    return this.provisioned.has(owner) ? { State: { Running: !this.stopped.has(owner) } } as never : null;
  }
  override async ensure(owner: string) {
    this.ensured.push(owner);
    this.provisioned.add(owner);
    this.stopped.delete(owner);
  }
  override async startRetained(owner: string) {
    if (!this.provisioned.has(owner)) throw new Error('No retained runtime is available.');
    this.retainedStarts.push(owner);
    this.stopped.delete(owner);
  }
  override async computerStatus(owner: string) {
    return { available: this.computerEnabled, running: this.provisioned.has(owner) && !this.stopped.has(owner), width: 1280 as const, height: 800 as const };
  }
  override async computerPause(_owner: string, paused: boolean) { this.pauses.push(paused); }
  async stop(owner: string) { this.stopped.add(owner); this.tokens.delete(owner); }
  override async synchronizeToken(owner: string, token: string) { this.tokens.set(owner, token); }
  override async clearToken(owner: string) {
    if (this.failClearToken) throw new Error('fixture token clear failure');
    this.tokens.delete(owner);
  }
  override async bridge(owner: string): Promise<ChildProcessWithoutNullStreams> {
    this.bridged.push(owner);
    const child = spawn(process.execPath, ['--input-type=module', '-e', RPC_FIXTURE], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        NODE_ENV: 'test', PATH: process.env.PATH ?? '/usr/bin:/bin', OWNER: owner,
        RPC_LOG: path.join(this.logDir, `${owner}.rpc.log`),
        FAIL_PROBE: this.failProbe ? '1' : '0', ACCOUNT_MODE: this.connectedAccount ? 'connected' : 'signedout',
        EMIT_STALE: this.emitStaleCompletion ? '1' : '0',
        WRONG_NATIVE_MODE: this.wrongNativeMode ? '1' : '0',
        COMPLETE_LOGIN: this.completeLogin,
        COMPLETE_DURING_CANCEL: this.completeDuringCancel ? '1' : '0',
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    this.children.add(child);
    child.once('exit', () => this.children.delete(child));
    return child;
  }

  async stopChildren() {
    const pending = [...this.children];
    for (const child of pending) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.all(pending.map(child => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>(resolve => child.once('exit', () => resolve()))));
  }
}

let root: string;
let socketPath: string;
let driver: FixtureDriver;
let broker: Awaited<ReturnType<typeof startPersonalBroker>> | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'personal-codex-broker-'));
  await chmod(root, 0o700);
  socketPath = path.join(root, 'broker.sock');
  driver = new FixtureDriver(['alice'], socketPath, root);
  broker = await startPersonalBroker(driver);
});

afterEach(async () => {
  try {
    if (broker) await broker.close();
  } finally {
    await driver.stopChildren();
    await rm(root, { recursive: true, force: true });
    broker = undefined;
  }
});

function ipc(action: string, owner = 'alice', method: 'GET' | 'POST' = 'POST', body?: string) {
  return socketFetch(socketPath)(`${LOCAL_ORIGIN}/${action}`, {
    method, headers: { 'x-collective-owner': owner }, ...(body === undefined ? {} : { body }),
  });
}

function runtimeClient(owner = 'alice') {
  return CodexClient.connect({ endpoint: 'ws://127.0.0.1/runtime', managed: true, socketPath, ownerId: owner } as never);
}

function deferNextBridge() {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const original = driver.bridge.bind(driver);
  vi.spyOn(driver, 'bridge').mockImplementationOnce(async owner => {
    const child = await original(owner);
    entered(); await wait;
    return child;
  });
  return { started, release };
}
const rpcLog = async (owner = 'alice') => readFile(path.join(root, `${owner}.rpc.log`), 'utf8').catch(() => '');

describe('Personal Codex protected broker', () => {
  it('starts with an empty owner list and rejects all owner actions without provisioning or sign-in', async () => {
    await broker!.close();
    driver = new FixtureDriver([], socketPath, root);
    broker = await startPersonalBroker(driver);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o660);
    for (const owner of ['alice', 'bob']) {
      for (const action of ['status', 'connect', 'start', 'cancel', 'disconnect']) {
        const response = await ipc(action, owner, action === 'status' ? 'GET' : 'POST');
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'This account is not enrolled in Personal Codex.', code: 'not_enrolled' });
      }
    }
    expect(driver.ensured).toEqual([]);
    expect(driver.retainedStarts).toEqual([]);
    expect(driver.bridged).toEqual([]);
    expect(driver.provisioned.size).toBe(0);
    expect(await readdir(root)).toEqual(['broker.sock']);
  });
  it('protects its UDS and status does not provision or start a native client', async () => {
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o660);
    const response = await ipc('status', 'alice', 'GET');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'not_started' });
    expect(driver!.ensured).toEqual([]);
    expect(driver!.bridged).toEqual([]);
  });

  it('admits only enrolled owners and does not provision on an unauthorized owner request', async () => {
    const status = await ipc('status', 'bob', 'GET');
    expect(status.status).toBe(403);
    expect(await status.json()).toEqual({ error: 'This account is not enrolled in Personal Codex.', code: 'not_enrolled' });
    const response = await ipc('connect', 'bob');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'This account is not enrolled in Personal Codex.', code: 'not_enrolled' });
    expect(driver!.ensured).toEqual([]);
    expect(driver!.bridged).toEqual([]);
  });

  it('connect provisions only its owner and keeps device login pending across new IPC clients', async () => {
    const first = await ipc('connect');
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody).toEqual({ state: 'running', account: { account: null, workspaceRouting: null }, login: {
      type: 'chatgptDeviceCode', loginId: 'alice-login-1', expiresAt: expect.any(String), verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'CODE-ALICE',
    } });
    const second = await ipc('status', 'alice', 'GET');
    expect(await second.json()).toEqual(firstBody);
    expect(driver.ensured).toEqual(['alice']);
    expect(driver.bridged).toEqual(['alice']);
    expect((await rpcLog()).match(/account\/login\/start/g)).toHaveLength(1);
  });

  it('rejects a companion provider before native account projection or login dispatch', async () => {
    driver.wrongNativeMode = true;
    const response = await ipc('connect'); expect(response.status).toBe(503);
    const methods = await rpcLog(); expect(methods).toContain('config/read');
    expect(methods).not.toContain('account/read'); expect(methods).not.toContain('account/login/start');
  });

  it('reads native accounts in proof-verified native mode and rejects companion token sync', async () => {
    driver.config.siwcSandboxVerified = true;
    driver.provisioned.add('alice'); driver.connectedAccount = true;
    const status = await (await ipc('status', 'alice', 'GET')).json();
    expect(status.account.account.email).toBe('alice@test.invalid');
    expect(status).not.toHaveProperty('siwc');
    const accessToken = 'synthetic-no-native-token-import';
    expect((await ipc('sync-token', 'alice', 'POST', JSON.stringify({accessToken,credentialBinding:tokenFingerprint(accessToken)}))).status).toBe(503);
    expect(driver.tokens.size).toBe(0);
  });

  it.each(['success', 'failure'] as const)('handles matching early native %s completion without exposing its error', async result => {
    driver.completeLogin = result;
    const response = await ipc('connect'); expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toHaveProperty('login'); expect(body).not.toHaveProperty('loginUncertain');
    if (result === 'success') expect(body.account.account.email).toBe('alice@test.invalid');
    else expect(body.loginOutcome).toBe('failed');
    expect(JSON.stringify(body)).not.toContain(AUTH_SENTINEL);
    expect((await readdir(root)).filter(file => file.endsWith('.pending'))).toEqual([]);
  });

  it('expires the bounded native login and revokes a completion racing expiration', async () => {
    driver.completeDuringCancel = true;
    const pending = await (await ipc('connect')).json();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(pending.login.expiresAt) + 1);
    try {
      const expired = await (await ipc('status', 'alice', 'GET')).json();
      expect(expired).toMatchObject({loginOutcome:'expired',account:{account:null}});
      expect(expired).not.toHaveProperty('login');
      expect(await rpcLog()).toContain('account/login/cancel'); expect(await rpcLog()).toContain('account/logout');
    } finally { clock.mockRestore(); }
  });

  it('automatically schedules owner-scoped expiry and cleans it when the deadline fires', async () => {
    const original = globalThis.setTimeout;
    let wake: (() => void) | undefined;
    const timer = vi.spyOn(globalThis,'setTimeout').mockImplementation(((callback: () => void, duration: number, ...args: unknown[]) => {
      if (duration === 15*60*1000) wake = callback;
      return original(callback,duration,...args);
    }) as typeof setTimeout);
    const pending = await (await ipc('connect')).json();
    expect(wake).toBeTypeOf('function');
    const clock = vi.spyOn(Date,'now').mockReturnValue(Date.parse(pending.login.expiresAt)+1);
    try {
      wake!();
      expect(await (await ipc('status','alice','GET')).json()).toMatchObject({loginOutcome:'expired'});
      expect((await rpcLog()).match(/account\/login\/cancel/g)).toHaveLength(1);
      expect((await rpcLog()).match(/account\/logout/g)).toHaveLength(1);
    } finally {clock.mockRestore();timer.mockRestore();}
  });

  it('logs out native credentials without companion token clearing or reprovisioning', async () => {
    driver.provisioned.add('alice'); driver.connectedAccount = true; driver.failClearToken = true;
    const clear = vi.spyOn(driver,'clearToken');
    const response = await ipc('disconnect'); expect(response.status).toBe(200);
    expect((await response.json()).account.account).toBeNull();
    expect(clear).not.toHaveBeenCalled(); expect(driver.ensured).toEqual([]);
    expect(await rpcLog()).toContain('account/logout');
  });

  it('refreshes with stock account/read refreshToken true and retains the owner account across broker restart', async () => {
    driver.provisioned.add('alice'); driver.connectedAccount = true;
    const first = await (await ipc('refresh')).json();
    expect(first.account.account.email).toBe('alice@test.invalid');
    const params = (await readFile(path.join(root,'alice.rpc.log.params'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    expect(params).toContainEqual({method:'account/read',params:{refreshToken:true}});
    await broker!.close(); broker = await startPersonalBroker(driver);
    expect(await (await ipc('status','alice','GET')).json()).toEqual(first);
    expect(await rpcLog()).not.toContain('account/login/start'); expect(driver.ensured).toEqual([]);
  });

  it('keeps runtime, bridge, and pending login identity separate for two enrolled owners', async () => {
    await broker!.close();
    driver = new FixtureDriver(['alice', 'bob'], socketPath, root);
    broker = await startPersonalBroker(driver);
    const [a, b] = await Promise.all([ipc('connect', 'alice'), ipc('connect', 'bob')]);
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    const [aStatus, bStatus] = await Promise.all([ipc('status', 'alice', 'GET'), ipc('status', 'bob', 'GET')]);
    expect((await aStatus.json()).login.userCode).toBe('CODE-ALICE');
    expect((await bStatus.json()).login.userCode).toBe('CODE-BOB');
    expect(driver.ensured.sort()).toEqual(['alice', 'bob']);
    expect(driver.bridged.sort()).toEqual(['alice', 'bob']);
  });

  it('retains a non-secret login uncertainty fence across broker restart without replaying sign-in', async () => {
    expect((await ipc('connect')).status).toBe(200);
    const marker = (await readdir(root)).find(file => file.endsWith('.pending'));
    expect(marker).toBeDefined();
    const markerPath = path.join(root, marker!);
    expect((await stat(markerPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(markerPath, 'utf8')).not.toMatch(/CODE-ALICE|alice-login|auth\.openai/);

    await broker!.close();
    broker = await startPersonalBroker(driver);
    expect(await (await ipc('status', 'alice', 'GET')).json()).toEqual({
      state: 'running', account: { account: null, workspaceRouting: null }, loginUncertain: true,
    });
    expect((await ipc('connect')).status).toBe(503);
    expect((await rpcLog()).match(/account\/login\/start/g)).toHaveLength(1);
    expect((await ipc('cancel')).status).toBe(200);
    expect(await (await ipc('status', 'alice', 'GET')).json()).not.toHaveProperty('loginUncertain');
    expect(await stat(markerPath).catch(() => null)).toBeNull();
    expect(await rpcLog()).toContain('account/logout');
    expect((await ipc('connect')).status).toBe(200);
    expect((await rpcLog()).match(/account\/login\/start/g)).toHaveLength(2);
  });

  it('reapplies a persisted desktop pause before accepting broker requests after a crash', async () => {
    driver.computerEnabled = true;
    driver.provisioned.add('alice');
    const record = path.join(root, `computer-${createHash('sha256').update('alice').digest('hex')}.json`);
    await writeFile(record, JSON.stringify({ version: 1, paused: true }), { mode: 0o600 });
    await broker!.close();
    broker = await startPersonalBroker(driver);

    expect(driver.pauses).toEqual([true]);
    const response = await socketFetch(socketPath)(`${LOCAL_ORIGIN}/computer/status`, {
      method: 'GET', headers: { 'x-collective-owner': 'alice', 'x-collective-view-session': 'a'.repeat(64) },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ paused: true, control: 'other' });
  });

  it('blocks connect when the native sandbox probe fails, before sign-in can start', async () => {
    driver.failProbe = true;
    const response = await ipc('connect');
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain('Personal Codex operation failed.');
    expect(body).not.toContain(AUTH_SENTINEL);
    expect(body).not.toContain(NATIVE_ERROR_SENTINEL);
    const methods = await rpcLog();
    expect(methods).toContain('command/exec');
    expect(methods).not.toContain('account/login/start');
    expect(driver.ensured).toEqual(['alice']);
    expect(driver.retainedStarts).toEqual([]);
  });

  it('reads an already retained account when the execution probe fails and does not provision a new runtime', async () => {
    driver.provisioned.add('alice');
    driver.connectedAccount = true;
    driver.failProbe = true;
    const response = await ipc('start');
    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text())).toMatchObject({ state: 'running', account: { account: { email: 'alice@test.invalid' } } });
    const methods = await rpcLog();
    expect(methods).toContain('account/read');
    expect(methods).not.toContain('command/exec');
    expect(driver.ensured).toEqual([]);
    expect(driver.retainedStarts).toEqual(['alice']);
  });

  it('disconnects a retained account without the execution probe, including when that probe would fail', async () => {
    driver.provisioned.add('alice');
    driver.connectedAccount = true;
    driver.failProbe = true;
    const response = await ipc('disconnect');
    expect(response.status).toBe(200);
    const methods = await rpcLog();
    expect(methods).toContain('account/read');
    expect(methods).toContain('account/logout');
    expect(methods).not.toContain('command/exec');
    expect(methods).not.toContain('account/login/start');
    expect(driver.ensured).toEqual([]);
    expect(driver.retainedStarts).toEqual(['alice']);
  });

  it('disconnects an enrolled owner with no runtime without provisioning or native login', async () => {
    const response = await ipc('disconnect');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'not_started' });
    expect(driver.ensured).toEqual([]); expect(driver.bridged).toEqual([]); expect(driver.retainedStarts).toEqual([]);
  });

  it('clears the SIWC app-server token and broker binding without relying on native account/logout', async () => {
    driver.config.siwcSandboxVerified = true; driver.config.authenticationMode = 'siwc';
    const token = 'fixture-siwc-token', fingerprint = tokenFingerprint(token);
    const sync = await ipc('sync-token', 'alice', 'POST', JSON.stringify({ accessToken: token, credentialBinding: fingerprint }));
    expect(sync.status).toBe(200);
    expect((await sync.json()).siwc.credentialBinding).toBe(fingerprint);
    expect(driver.tokens.get('alice')).toBe(token);
    expect((await ipc('disconnect')).status).toBe(200);
    expect(driver.tokens.has('alice')).toBe(false);
    expect(await (await ipc('status', 'alice', 'GET')).json()).toEqual({ state: 'running', siwc: { available: true, reason: expect.any(String) } });
    expect(driver.bridged).toEqual([]);
    expect(await rpcLog()).not.toContain('account/logout');
  });

  it('removes trusted broker readiness even when clearing the SIWC runtime token fails, and allows explicit retry', async () => {
    driver.config.siwcSandboxVerified = true; driver.config.authenticationMode = 'siwc';
    const token = 'fixture-siwc-token', fingerprint = tokenFingerprint(token);
    expect((await ipc('sync-token', 'alice', 'POST', JSON.stringify({ accessToken: token, credentialBinding: fingerprint }))).status).toBe(200);
    driver.failClearToken = true;
    const failure = await ipc('disconnect');
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain('fixture token clear failure');
    expect(driver.tokens.get('alice')).toBe(token);
    expect((await (await ipc('status', 'alice', 'GET')).json()).siwc).not.toHaveProperty('credentialBinding');
    await expect(runtimeClient()).rejects.toThrow('connection failed');
    expect(driver.bridged).toEqual([]);
    driver.failClearToken = false;
    expect((await ipc('disconnect')).status).toBe(200);
    expect(driver.tokens.has('alice')).toBe(false);
  });

  it('denies a surviving guest SIWC token after broker restart until an explicit fresh sync', async () => {
    driver.config.siwcSandboxVerified = true; driver.config.authenticationMode = 'siwc';
    const accessToken = 'synthetic-retained-guest-token';
    const body = JSON.stringify({ accessToken, credentialBinding: tokenFingerprint(accessToken) });
    expect((await ipc('sync-token', 'alice', 'POST', body)).status).toBe(200);
    const clear = vi.spyOn(driver, 'clearToken');
    await broker!.close(); broker = await startPersonalBroker(driver);
    expect(driver.tokens.get('alice')).toBe(accessToken);
    expect(clear).not.toHaveBeenCalled();
    await expect(runtimeClient()).rejects.toThrow('connection failed');
    expect(driver.bridged).toEqual([]);
    expect((await ipc('sync-token', 'alice', 'POST', body)).status).toBe(200);
    const client = await runtimeClient();
    client.close();
    expect(driver.bridged).toEqual(['alice']);
  });

  it.each(['disconnect', 'sync-token'] as const)('rejects an upgrade waiting on a bridge when %s invalidates SIWC authority', async action => {
    driver.config.siwcSandboxVerified = true; driver.config.authenticationMode = 'siwc';
    const accessToken = 'synthetic-race-token';
    const body = JSON.stringify({ accessToken, credentialBinding: tokenFingerprint(accessToken) });
    expect((await ipc('sync-token', 'alice', 'POST', body)).status).toBe(200);
    const active = await runtimeClient();
    const invalidated = new Promise<void>(resolve => { active.onFailure(() => resolve()); });
    const deferred = deferNextBridge();
    const pending = runtimeClient().then(client => { client.close(); return null; }, error => error);
    await deferred.started;
    const mutation = ipc(action, 'alice', 'POST', action === 'sync-token' ? body : undefined);
    try {
      // Even a queued mutation fences authority and existing transports before
      // waiting for the earlier asynchronous driver bridge to return.
      await invalidated;
    } finally { deferred.release(); active.close(); }
    expect(await pending).toBeInstanceOf(Error);
    expect((await mutation).status).toBe(200);
    if (action === 'sync-token') {
      const fresh = await runtimeClient(); fresh.close();
    } else await expect(runtimeClient()).rejects.toThrow('connection failed');
  });

  it('rechecks owner admission after an asynchronous bridge wait', async () => {
    driver.config.siwcSandboxVerified = true; driver.config.authenticationMode = 'siwc';
    const accessToken = 'synthetic-admission-token';
    expect((await ipc('sync-token', 'alice', 'POST', JSON.stringify({ accessToken, credentialBinding: tokenFingerprint(accessToken) }))).status).toBe(200);
    const deferred = deferNextBridge();
    const pending = runtimeClient().then(client => { client.close(); return null; }, error => error);
    await deferred.started;
    driver.config.owners = [];
    deferred.release();
    expect(await pending).toBeInstanceOf(Error);
  });

  it('drops SIWC readiness when status observes a stopped runtime', async () => {
    driver.config.siwcSandboxVerified = true; driver.config.authenticationMode = 'siwc';
    const token = 'fixture-siwc-token', fingerprint = tokenFingerprint(token);
    expect((await ipc('sync-token', 'alice', 'POST', JSON.stringify({ accessToken: token, credentialBinding: fingerprint }))).status).toBe(200);
    driver.stopped.add('alice');

    const response = await ipc('status', 'alice', 'GET');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'stopped', siwc: { available: true, reason: expect.any(String) } });
  });

  it('drops SIWC readiness before starting a stopped retained runtime', async () => {
    driver.config.siwcSandboxVerified = true; driver.config.authenticationMode = 'siwc';
    const token = 'fixture-siwc-token', fingerprint = tokenFingerprint(token);
    expect((await ipc('sync-token', 'alice', 'POST', JSON.stringify({ accessToken: token, credentialBinding: fingerprint }))).status).toBe(200);
    driver.stopped.add('alice');

    const response = await ipc('start');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'running', siwc: { available: true, reason: expect.any(String) } });
    expect(driver.retainedStarts).toEqual(['alice']);
  });

  it('keeps SIWC status readable during takeover and revokes a paused desktop without resuming it', async () => {
    driver.config.siwcSandboxVerified = true; driver.config.authenticationMode = 'siwc';
    driver.computerEnabled = true;
    const token = 'fixture-siwc-token', fingerprint = tokenFingerprint(token);
    const syncBody = JSON.stringify({ accessToken: token, credentialBinding: fingerprint });
    expect((await ipc('sync-token', 'alice', 'POST', syncBody)).status).toBe(200);
    const takeover = await socketFetch(socketPath)(`${LOCAL_ORIGIN}/computer/control`, {
      method: 'POST', headers: { 'x-collective-owner': 'alice', 'x-collective-view-session': 'a'.repeat(64) },
      body: JSON.stringify({ action: 'takeover' }),
    });
    expect(takeover.status).toBe(200);
    expect((await takeover.json()).paused).toBe(true);
    const status = await ipc('status', 'alice', 'GET');
    expect(status.status).toBe(200);
    expect((await status.json()).siwc.credentialBinding).toBe(fingerprint);
    expect((await ipc('sync-token', 'alice', 'POST', syncBody)).status).toBe(503);
    const disconnect = await ipc('disconnect');
    expect(disconnect.status).toBe(200);
    expect(await disconnect.json()).toMatchObject({ state: 'stopped', siwc: { available: true } });
    expect(driver.tokens.has('alice')).toBe(false);
    expect(driver.stopped.has('alice')).toBe(true);
    expect(driver.pauses).toEqual([true]);
    expect(driver.retainedStarts).toEqual([]);
    expect(driver.bridged).toEqual([]);
    const later = await ipc('status', 'alice', 'GET');
    expect((await later.json()).siwc).not.toHaveProperty('credentialBinding');
  });

  it('still clears a retained SIWC token when an operator has disabled capability admission', async () => {
    driver.config.siwcSandboxVerified = true; driver.config.authenticationMode = 'siwc';
    const token = 'fixture-siwc-token';
    expect((await ipc('sync-token', 'alice', 'POST', JSON.stringify({ accessToken: token, credentialBinding: tokenFingerprint(token) }))).status).toBe(200);
    driver.config.siwcSandboxVerified = false;
    expect((await ipc('disconnect')).status).toBe(200);
    expect(driver.tokens.has('alice')).toBe(false);
    expect(await rpcLog()).not.toContain('account/logout');
    driver.config.siwcSandboxVerified = true; driver.config.authenticationMode = 'siwc';
    expect((await (await ipc('status', 'alice', 'GET')).json()).siwc).not.toHaveProperty('credentialBinding');
  });

  it('rejects unexpected request bodies and HTTP actions', async () => {
    const withBody = await ipc('connect', 'alice', 'POST', '{}');
    expect(withBody.status).toBe(400);
    const wrongMethod = await ipc('connect', 'alice', 'GET');
    expect(wrongMethod.status).toBe(404);
    const wrongAction = await ipc('delete-all', 'alice', 'POST');
    expect(wrongAction.status).toBe(404);
    expect(driver.ensured).toEqual([]);
  });

  it('clears only matching login completion IDs and keeps a newer login pending', async () => {
    driver.emitStaleCompletion = true;
    const first = await ipc('connect');
    expect((await first.json()).login.loginId).toBe('alice-login-1');
    await ipc('cancel');
    const second = await ipc('connect');
    const result = await second.json();
    expect(result.login.loginId).toBe('alice-login-2');
    expect(result.login.userCode).toBe('CODE-ALICE');
  });

  it('revokes a native grant that completes while an explicit sign-in cancellation is in flight', async () => {
    driver.completeDuringCancel = true;
    expect((await ipc('connect')).status).toBe(200);
    const response = await ipc('cancel');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'running', account: { account: null, workspaceRouting: null } });
    expect(await rpcLog()).toContain('account/logout');
  });

  it('projects native account fields and hides auth material and native error text', async () => {
    driver.provisioned.add('alice');
    driver.connectedAccount = true;
    driver.failProbe = true;
    const response = await ipc('start');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ state: 'running', account: {
      account: { type: 'chatgpt', email: 'alice@test.invalid', planType: 'business' },
      workspaceRouting: { chatgptAccountId: 'workspace-alice', backendOrigin: 'https://private.native.invalid', accountRoutingOverride: 'us' },
    } });
    expect(body).not.toContain(AUTH_SENTINEL);
    expect(body).not.toContain(NATIVE_ERROR_SENTINEL);
    expect((await rpcLog())).not.toContain('command/exec');
    expect(driver.ensured).toEqual([]);
    expect(driver.retainedStarts).toEqual(['alice']);
  });
});

describe('broker self enrollment', () => {
  const consent = JSON.stringify({ consentVersion: 1, sessionVersion: 7 });
  function capable() {
    driver.config.allowSelfEnrollment = true; driver.config.siwcSandboxVerified = true; driver.config.authenticationMode = 'siwc';
    return vi.spyOn(driver, 'preflight').mockResolvedValue('not_started');
  }
  it('readiness is read only and default capability rejects preparation by an unadmitted owner', async () => {
    expect((await (await ipc('readiness', 'bob', 'GET')).json()).state).toBe('operator_setup_required');
    expect((await ipc('prepare', 'bob', 'POST', consent)).status).toBe(403);
    expect(driver.ensured).toEqual([]);
    expect((await readdir(root)).filter(f => f.startsWith('codex-enrollment-'))).toEqual([]);
    capable(); expect((await (await ipc('readiness', 'bob', 'GET')).json()).runtimeState).toBe('not_started');
    expect(driver.admitted('bob')).toBe(false); expect(driver.ensured).toEqual([]);
  });
  it('prepares native device mode without synchronizing or clearing a companion token', async () => {
    driver.config.allowSelfEnrollment = true; driver.config.siwcSandboxVerified = true;
    vi.spyOn(driver,'preflight').mockResolvedValue('not_started'); driver.failClearToken = true;
    const clear = vi.spyOn(driver,'clearToken');
    expect(await (await ipc('prepare','bob','POST',consent)).json()).toMatchObject({state:'ready',enrolled:true,runtimeState:'running'});
    expect(driver.ensured).toEqual(['bob']); expect(driver.tokens.size).toBe(0); expect(clear).not.toHaveBeenCalled();
    expect(await (await ipc('status','bob','GET')).json()).toEqual({state:'running',account:{account:null,workspaceRouting:null}});
    expect(await rpcLog()).not.toContain('account/login/start');
  });

  it('preflights before admission and enforces strict owner-independent body', async () => {
    const preflight = capable().mockRejectedValue(new Error('private preflight failure'));
    const response = await ipc('prepare', 'bob', 'POST', consent);
    expect((await response.json()).state).toBe('unavailable'); expect(driver.admitted('bob')).toBe(false);
    expect(driver.ensured).toEqual([]);
    preflight.mockResolvedValue('not_started');
    expect((await ipc('prepare', 'bob', 'POST', JSON.stringify({ consentVersion: 1, sessionVersion: 7, owner: 'alice' }))).status).toBe(503);
    expect(driver.admitted('bob')).toBe(false);
  });
  it('prepares distinct owners and restores admission but requires fresh token synchronization on restart', async () => {
    capable();
    for (const owner of ['alice', 'bob']) expect(await (await ipc('prepare', owner, 'POST', consent)).json()).toMatchObject({ state: 'ready', enrolled: true, runtimeState: 'running' });
    expect(driver.ensured).toEqual(['alice', 'bob']);
    expect(driver.tokens.size).toBe(0);
    expect((await ipc('status', 'bob', 'GET')).status).toBe(200);
    await broker!.close(); driver = new FixtureDriver([], socketPath, root); capable();
    broker = await startPersonalBroker(driver);
    expect(driver.admitted('alice')).toBe(true); expect(driver.admitted('bob')).toBe(true);
    const status = await (await ipc('status', 'bob', 'GET')).json(); expect(status.siwc.credentialBinding).toBeUndefined();
    expect(status.siwc.reason).toContain('synchronization');
  });
  it('restores persisted computer pauses for owners admitted by consent receipts', async () => {
    capable();
    expect((await ipc('prepare', 'bob', 'POST', consent)).status).toBe(200);
    const record = path.join(root, `computer-${createHash('sha256').update('bob').digest('hex')}.json`);
    await writeFile(record, JSON.stringify({ version: 1, paused: true }), { mode: 0o600 });
    await broker!.close();
    driver = new FixtureDriver([], socketPath, root);
    capable(); driver.computerEnabled = true; driver.provisioned.add('bob');
    broker = await startPersonalBroker(driver);
    expect(driver.admitted('bob')).toBe(true);
    expect(driver.admittedOwners()).toContain('bob');
    expect(driver.pauses).toEqual([true]);
    expect((await ipc('start', 'bob')).status).toBe(503);
    expect(driver.retainedStarts).toEqual([]);
  });
  it('rolls back fresh admission on uncertain setup and never creates token readiness on failure', async () => {
    capable(); vi.spyOn(driver, 'ensure').mockRejectedValueOnce(new Error('private setup failure'));
    expect((await ipc('prepare', 'bob', 'POST', consent)).status).toBe(503); expect(driver.admitted('bob')).toBe(false);
    expect((await readdir(root)).filter(f => f.startsWith('codex-enrollment-'))).toEqual([]);
    driver.provisioned.add('alice');
    driver.failClearToken = true;
    expect((await ipc('prepare', 'alice', 'POST', consent)).status).toBe(503);
    expect((await (await ipc('status', 'alice', 'GET')).json()).siwc.credentialBinding).toBeUndefined();
  });
});

it('failed prepare with unlink failure rejects dynamic owner in current broker and after restart', async () => {
  await broker!.close(); driver = new FixtureDriver([], socketPath, root);
  driver.config.allowSelfEnrollment = true; driver.config.siwcSandboxVerified = true; driver.config.authenticationMode = 'siwc';
  vi.spyOn(driver, 'preflight').mockResolvedValue('not_started');
  vi.spyOn(driver, 'ensure').mockRejectedValue(new Error('uncertain setup'));
  broker = await startPersonalBroker(driver, new EnrollmentJournal(driver, async () => { throw new Error('unlink failure'); }));
  expect((await ipc('prepare', 'bob', 'POST', JSON.stringify({ consentVersion: 1, sessionVersion: 9 }))).status).toBe(503);
  expect(driver.admitted('bob')).toBe(false); expect((await ipc('status', 'bob', 'GET')).status).toBe(403);
  await broker.close(); driver = new FixtureDriver([], socketPath, root);
  driver.config.allowSelfEnrollment = true; driver.config.siwcSandboxVerified = true; driver.config.authenticationMode = 'siwc';
  broker = await startPersonalBroker(driver);
  expect((await ipc('status', 'bob', 'GET')).status).toBe(403); expect(driver.tokens.size).toBe(0);
});

it('connected preparation is idempotent and failed read-only preflight retains its token binding', async () => {
  driver.config.siwcSandboxVerified = true; driver.config.authenticationMode = 'siwc';
  const preflight = vi.spyOn(driver, 'preflight').mockResolvedValue('running');
  const clear = vi.spyOn(driver, 'clearToken');
  const accessToken = 'synthetic-existing-connection'; const credentialBinding = tokenFingerprint(accessToken);
  expect((await ipc('sync-token', 'alice', 'POST', JSON.stringify({ accessToken, credentialBinding }))).status).toBe(200);
  const ensured = driver.ensured.length;
  const consent = JSON.stringify({ consentVersion: 1, sessionVersion: 10 });
  expect((await ipc('prepare', 'alice', 'POST', consent)).status).toBe(200);
  expect(clear).not.toHaveBeenCalled(); expect(driver.ensured.length).toBe(ensured);
  expect(driver.tokens.get('alice')).toBe(accessToken);
  preflight.mockRejectedValue(new Error('private readiness error'));
  expect((await (await ipc('prepare', 'alice', 'POST', consent)).json()).state).toBe('unavailable');
  expect((await (await ipc('status', 'alice', 'GET')).json()).siwc.credentialBinding).toBe(credentialBinding);
  expect(driver.tokens.get('alice')).toBe(accessToken); expect(clear).not.toHaveBeenCalled();
});
