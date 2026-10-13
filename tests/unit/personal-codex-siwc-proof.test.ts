import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Script } from 'node:vm';
import { siwcChildCommand, siwcToolCommand, siwcToolEvidence, passedSiwcChild, siwcAppServerObservation,
  passedSiwcAppServerObservation, siwcSocketPositiveControl } from '../../scripts/lib/personal-codex-siwc-proof.mjs';

const proof = (nonce: string) => ({ probe: 'siwcToolIsolation', nonce, pid: 20, accessTokenPresent: false,
  child: { status: 0, signal: null, spawnError: false, stderrEmpty: true, stdoutJsonExact: true,
    proof: { probe: 'siwcChildEnvironment', nonce, pid: 21, accessTokenPresent: false } },
  parentEnvironDenied: true, parentEnvironError: 'ENOENT', socketDenied: true, socketError: 'EACCES' });
const reply = (value: unknown) => ({ result: { exitCode: 0, stderr: '', stdout: JSON.stringify(value) } });

describe('synthetic SIWC parent and child observations', () => {
  it('requires exact positive child output with a distinct PID and the matching nonce', () => {
    const nonce = randomUUID(), valid = proof(nonce);
    expect(siwcToolEvidence(reply(valid), nonce).passed).toBe(true);
    for (const patch of [{ pid: 20 }, { pid: 0 }, { pid: undefined }, { nonce: randomUUID() },
      { accessTokenPresent: true }, { extra: true }, { probe: 'passed' }]) {
      expect(passedSiwcChild({ ...valid.child.proof, ...patch }, nonce, 20)).toBe(false);
    }
    for (const patch of [{ status: null }, { status: 1 }, { signal: 'SIGSYS' }, { spawnError: true },
      { stderrEmpty: false }, { stdoutJsonExact: false }, { proof: null }, { proof: { passed: true } }]) {
      expect(siwcToolEvidence(reply({ ...valid, child: { ...valid.child, ...patch } }), nonce).passed).toBe(false);
    }
    expect(siwcToolEvidence({ result: { exitCode: 0, stderr: '', stdout: '' } }, nonce).passed).toBe(false);
    expect(siwcToolEvidence({ ...reply(valid), error: { message: 'EPERM' } }, nonce).passed).toBe(false);
    expect(siwcToolEvidence({ result: { exitCode: 0, stderr: 'EPERM', stdout: JSON.stringify(valid) } }, nonce).passed).toBe(false);
    expect(siwcToolEvidence(reply({ ...valid, accessTokenPresent: true }), nonce).passed).toBe(false);
    expect(siwcToolEvidence(reply({ ...valid, parentEnvironDenied: false }), nonce).passed).toBe(false);
    expect(siwcToolEvidence(reply({ ...valid, parentEnvironError: 'EIO' }), nonce).passed).toBe(false);
    expect(siwcToolEvidence(reply({ ...valid, socketError: 'ECONNREFUSED' }), nonce).passed).toBe(false);
  });

  it('executes a real synthetic child and detects an inherited token positive control', () => {
    const nonce = randomUUID();
    const execute = (token?: string) => spawnSync(process.execPath, ['-e', siwcChildCommand(nonce)], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore','pipe','pipe'],
      env: { PATH: '/usr/bin:/bin', ...(token === undefined ? {} : { ACCESS_TOKEN: token }) },
    });
    const without = execute();
    expect(without.error).toBeUndefined(); expect(without.status).toBe(0); expect(without.signal).toBeNull(); expect(without.stderr).toBe('');
    const observed = JSON.parse(without.stdout);
    expect(observed.pid).toBe(without.pid);
    expect(passedSiwcChild(observed, nonce, process.pid)).toBe(true);
    expect(without.stdout).toBe(JSON.stringify(observed));
    const withToken = execute('fixture-only-child-positive-control');
    expect(withToken.error).toBeUndefined(); expect(withToken.status).toBe(0); expect(withToken.stderr).toBe('');
    const positive = JSON.parse(withToken.stdout);
    expect(positive).toMatchObject({ nonce, pid: withToken.pid, accessTokenPresent: true });
    expect(passedSiwcChild(positive, nonce, process.pid)).toBe(false);
    expect(withToken.stdout).not.toContain('fixture-only-child-positive-control');
  });

  it('rejects a generated parent observation when a zero-exit child emits nothing or EPERM stderr', () => {
    const nonce = randomUUID();
    for (const stderr of ['', 'EPERM']) {
      let output = '';
      const socket = { destroy() {}, setTimeout() {}, once(event: string, handler: (error: { code: string }) => void) {
        if (event === 'error') handler({ code: 'EACCES' }); return this;
      } };
      const fixtureRequire = (module: string) => {
        if (module === 'node:fs') return { readFileSync() { throw Object.assign(new Error('absent synthetic PID'), { code: 'ENOENT' }); } };
        if (module === 'node:net') return { connect: () => socket };
        if (module === 'node:child_process') return { spawnSync(_file: string, _args: string[], options: Record<string, unknown>) {
          expect(options.stdio).toEqual(['ignore','pipe','pipe']); expect(options).not.toHaveProperty('env');
          return { status: 0, signal: null, stdout: '', stderr };
        } };
        throw new Error('Unexpected fixture module');
      };
      new Script(siwcToolCommand(nonce, 30)).runInNewContext({ require: fixtureRequire,
        process: { execPath: '/fixture/node', pid: 20, env: {}, stdout: { write(value: string) { output += value; } } } });
      const generated = JSON.parse(output);
      expect(generated.child.status).toBe(0); expect(generated.child.proof).toBeNull();
      expect(generated.child.stdoutJsonExact).toBe(false);
      expect(siwcToolEvidence(reply(generated), nonce).passed).toBe(false);
    }
  });

  it('runs the generated parent and child with inherited environment and ignored child stdin', () => {
    const nonce = randomUUID();
    // These are synthetic local observation checks, not a runtime isolation proof:
    // the deliberately absent parent PID/socket cannot establish a denial boundary.
    for (const present of [false, true]) {
      const run = spawnSync(process.execPath, ['-e', siwcToolCommand(nonce, 2147483000)], {
        encoding: 'utf8', timeout: 5000, stdio: ['ignore','pipe','pipe'],
        env: { PATH: '/usr/bin:/bin', ...(present ? { ACCESS_TOKEN: 'fixture-only-parent-positive-control' } : {}) },
      });
      expect(run.error).toBeUndefined(); expect(run.status).toBe(0); expect(run.signal).toBeNull(); expect(run.stderr).toBe('');
      const observed = JSON.parse(run.stdout);
      expect(observed.pid).toBe(run.pid);
      expect(observed.accessTokenPresent).toBe(present);
      expect(observed.child).toMatchObject({ status: 0, signal: null, spawnError: false, stderrEmpty: true, stdoutJsonExact: true });
      expect(observed.child.proof.accessTokenPresent).toBe(present);
      expect(observed.child.proof.pid).toBeGreaterThan(0); expect(observed.child.proof.pid).not.toBe(run.pid);
      expect(run.stdout).not.toContain('fixture-only-parent-positive-control');
    }
  });

  it('never exports arbitrary child output or token content in its evidence', () => {
    const nonce = randomUUID(), valid = proof(nonce);
    valid.child.proof = { ...valid.child.proof, accessTokenPresent: true };
    const observation = siwcToolEvidence(reply({ ...valid, child: { ...valid.child, proof: { token: 'fixture-only-secret' } } }), nonce);
    expect(observation.passed).toBe(false);
    expect(JSON.stringify(observation)).not.toContain('fixture-only-secret');
  });

  it('requires complete outside-token scans and clear with a different live app-server PID', () => {
    const present = { appServerCount: 1, appServerPid: 30, sentinelPresent: true, accessTokenPresent: true,
      sentinelCount: 1, accessTokenCount: 1, scanComplete: true };
    expect(passedSiwcAppServerObservation(present, true, 29)).toBe(true);
    for (const patch of [{ scanComplete: false }, { appServerCount: 0 }, { appServerCount: 2 },
      { appServerPid: null }, { sentinelPresent: false }, { sentinelCount: 2 }, { accessTokenCount: 2 }]) {
      expect(passedSiwcAppServerObservation({ ...present, ...patch }, true)).toBe(false);
    }
    const cleared = { ...present, appServerPid: 31, sentinelPresent: false, accessTokenPresent: false, sentinelCount: 0, accessTokenCount: 0 };
    expect(passedSiwcAppServerObservation(cleared, false, 30)).toBe(true);
    expect(passedSiwcAppServerObservation({ ...cleared, appServerPid: 30 }, false, 30)).toBe(false);
    expect(passedSiwcAppServerObservation({ ...cleared, accessTokenCount: 1 }, false, 30)).toBe(false);
  });

  it('generates valid bounded scripts and rejects nonces, PIDs and alternate socket paths', () => {
    const nonce = randomUUID();
    for (const script of [siwcChildCommand(nonce), siwcToolCommand(nonce, 42), siwcAppServerObservation(nonce), siwcSocketPositiveControl()]) {
      expect(() => new Script(script)).not.toThrow(); expect(script.length).toBeLessThan(8192);
    }
    expect(() => siwcChildCommand('../private')).toThrow('Invalid synthetic SIWC nonce');
    expect(() => siwcToolCommand(nonce, 0)).toThrow('Invalid app-server PID');
    expect(() => siwcToolCommand(nonce, 42, '/tmp/alternate')).toThrow('Unreviewed SIWC socket path');
  });
});
