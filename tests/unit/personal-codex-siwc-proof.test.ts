import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Script } from 'node:vm';
import { SIWC_NODE_EXECUTABLE, siwcChildCommand, siwcToolCommand, siwcToolEvidence, passedSiwcChild, siwcAppServerObservation,
  passedSiwcAppServerObservation, siwcSocketPositiveControl } from '../../scripts/lib/personal-codex-siwc-proof.mjs';

const childProof = (nonce: string, pid = 21) => ({ probe: 'siwcChildEnvironment', nonce, pid, accessTokenPresent: false });
const childObservation = (nonce: string, writerMode = 'stream', pid = 21) => ({ writerMode, spawnPid: pid,
  status: 0, signal: null, spawnError: false, spawnErrorCode: null, spawnErrorSyscall: null, spawnErrorMessage: null,
  spawnExecutable: SIWC_NODE_EXECUTABLE, stdoutType: 'string', stdoutBytes: Buffer.byteLength(JSON.stringify(childProof(nonce, pid))), stdoutEmpty: false,
  stderrType: 'string', stderrBytes: 0, stderrEmpty: true, stdoutJsonParsed: true, stdoutJsonExact: true, stdoutJsonSchemaExact: true,
  accessTokenObserved: false, proof: childProof(nonce, pid) });
const proof = (nonce: string) => ({ probe: 'siwcToolIsolation', nonce, pid: 20, accessTokenPresent: false,
  child: childObservation(nonce), comparison: childObservation(nonce, 'sync', 22),
  parentEnvironDenied: true, parentEnvironError: 'ENOENT', socketDenied: true, socketError: 'EACCES' });
const reply = (value: unknown) => ({ result: { exitCode: 0, stderr: '', stdout: JSON.stringify(value) } });
function generatedObservation(nonce: string, children: Array<Record<string, unknown>>) {
  let output = '', next = 0;
  const socket = { destroy() {}, setTimeout() {}, once(event: string, handler: (error: { code: string }) => void) {
    if (event === 'error') handler({ code: 'EACCES' }); return this;
  } };
  const fixtureRequire = (module: string) => {
    if (module === 'node:fs') return { readFileSync() { throw Object.assign(new Error('absent synthetic PID'), { code: 'ENOENT' }); } };
    if (module === 'node:net') return { connect: () => socket };
    if (module === 'node:child_process') return { spawnSync(file: string, args: string[], options: Record<string, unknown>) {
      expect(file).toBe(SIWC_NODE_EXECUTABLE); expect(options).not.toHaveProperty('env');
      expect(options.stdio).toEqual(['ignore','pipe','pipe']);
      expect(args[1]).toContain(next === 0 ? 'process.stdout.write' : "require('node:fs').writeSync(1,");
      const index = next++;
      return { pid: 21 + index, status: 0, signal: null, stdout: JSON.stringify(childProof(nonce, 21 + index)), stderr: '', ...children[index] };
    } };
    throw new Error('Unexpected fixture module');
  };
  new Script(siwcToolCommand(nonce, 30)).runInNewContext({ require: fixtureRequire, Buffer,
    process: { execPath: 'node', pid: 20, env: {}, stdout: { write(value: string) { output += value; } } } });
  expect(next).toBe(2);
  return JSON.parse(output);
}

describe('synthetic SIWC parent and child observations', () => {
  it('requires exact positive child output with a distinct PID and the matching nonce', () => {
    const nonce = randomUUID(), valid = proof(nonce);
    expect(siwcToolEvidence(reply(valid), nonce).passed).toBe(true);
    for (const patch of [{ pid: 20 }, { pid: 0 }, { pid: undefined }, { nonce: randomUUID() },
      { accessTokenPresent: true }, { extra: true }, { probe: 'passed' }]) {
      expect(passedSiwcChild({ ...valid.child.proof, ...patch }, nonce, 20)).toBe(false);
    }
    for (const patch of [{ status: null }, { status: 1 }, { signal: 'SIGSYS' }, { spawnError: true },
      { spawnErrorCode: 'ENOENT' }, { spawnErrorSyscall: 'spawnSync node' }, { spawnErrorMessage: 'spawnSync node ENOENT' }, { spawnExecutable: 'node' },
      { stderrEmpty: false }, { stderrBytes: 1 }, { stdoutType: 'buffer' }, { stdoutBytes: 0 }, { stdoutEmpty: true },
      { stdoutJsonParsed: false }, { stdoutJsonSchemaExact: false }, { stdoutJsonExact: false }, { spawnPid: 22 },
      { writerMode: 'sync' }, { proof: null }, { proof: { passed: true } }]) {
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

  it.each(['stream','sync'] as const)('executes a real %s child without PATH and detects inherited token', writerMode => {
    const nonce = randomUUID();
    const execute = (token?: string) => spawnSync(process.execPath, ['-e', siwcChildCommand(nonce, writerMode)], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore','pipe','pipe'],
      env: { NODE_ENV: 'test', ...(token === undefined ? {} : { ACCESS_TOKEN: token }) },
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
        if (module === 'node:child_process') return { spawnSync(file: string, _args: string[], options: Record<string, unknown>) {
          expect(file).toBe(SIWC_NODE_EXECUTABLE);
          expect(options.stdio).toEqual(['ignore','pipe','pipe']); expect(options).not.toHaveProperty('env');
          return { pid: 21, status: 0, signal: null, stdout: '', stderr };
        } };
        throw new Error('Unexpected fixture module');
      };
      new Script(siwcToolCommand(nonce, 30)).runInNewContext({ require: fixtureRequire, Buffer,
        process: { execPath: 'node', pid: 20, env: {}, stdout: { write(value: string) { output += value; } } } });
      const generated = JSON.parse(output);
      expect(generated.child.status).toBe(0); expect(generated.child.proof).toBeNull();
      expect(generated.child.stdoutJsonExact).toBe(false);
      expect(generated.child).toMatchObject({ spawnPid: 21, stdoutType: 'string', stdoutBytes: 0, stdoutEmpty: true,
        stdoutJsonParsed: false, stdoutJsonSchemaExact: false });
      expect(siwcToolEvidence(reply(generated), nonce).passed).toBe(false);
    }
  });

  it('runs the generated parent and child with inherited environment and ignored child stdin', () => {
    const nonce = randomUUID();
    // These are synthetic local observation checks, not a runtime isolation proof:
    // the deliberately absent parent PID/socket cannot establish a denial boundary.
    for (const present of [false, true]) {
      // Test-only adapter asserts the production image pin, then runs this host's
      // Node with precisely the same options and inherited environment.
      const adapter = `const fixtureCp=require('node:child_process'),fixtureSpawn=fixtureCp.spawnSync;
        fixtureCp.spawnSync=(file,args,options)=>{if(file!==${JSON.stringify(SIWC_NODE_EXECUTABLE)})throw new Error('Child executable was not pinned');
          if(Object.prototype.hasOwnProperty.call(options,'env'))throw new Error('Child environment was replaced');
          return fixtureSpawn(process.execPath,args,options);};`;
      const run = spawnSync(process.execPath, ['-e', adapter + siwcToolCommand(nonce, 2147483000)], {
        encoding: 'utf8', timeout: 10000, stdio: ['ignore','pipe','pipe'],
        env: { NODE_ENV: 'test', ...(present ? { ACCESS_TOKEN: 'fixture-only-parent-positive-control' } : {}) },
      });
      expect(run.error).toBeUndefined(); expect(run.status).toBe(0); expect(run.signal).toBeNull(); expect(run.stderr).toBe('');
      const observed = JSON.parse(run.stdout);
      expect(observed.pid).toBe(run.pid);
      expect(observed.accessTokenPresent).toBe(present);
      expect(observed.child).toMatchObject({ status: 0, signal: null, spawnError: false, stderrEmpty: true, stdoutJsonExact: true });
      expect(observed.child.proof.accessTokenPresent).toBe(present);
      expect(observed.child.proof.pid).toBeGreaterThan(0); expect(observed.child.proof.pid).not.toBe(run.pid);
      expect(observed.child.spawnPid).toBe(observed.child.proof.pid);
      expect(observed.comparison).toMatchObject({ writerMode: 'sync', status: 0, stdoutJsonParsed: true, stdoutJsonExact: true,
        stdoutJsonSchemaExact: true, accessTokenObserved: present });
      expect(observed.comparison.spawnPid).toBe(observed.comparison.proof.pid);
      expect(observed.comparison.proof.pid).not.toBe(observed.child.proof.pid);
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

  it('reports stream type, bytes, JSON parsing and exact schema as distinct observations', () => {
    const nonce = randomUUID(), validJson = JSON.stringify(childProof(nonce));
    for (const [stdout, expected] of [
      ['', { stdoutType: 'string', stdoutBytes: 0, stdoutEmpty: true, stdoutJsonParsed: false, stdoutJsonExact: false, stdoutJsonSchemaExact: false }],
      [undefined, { stdoutType: 'undefined', stdoutBytes: null, stdoutEmpty: null, stdoutJsonParsed: false, stdoutJsonSchemaExact: false }],
      [null, { stdoutType: 'null', stdoutBytes: null, stdoutEmpty: null, stdoutJsonParsed: false, stdoutJsonSchemaExact: false }],
      ['null', { stdoutType: 'string', stdoutBytes: 4, stdoutEmpty: false, stdoutJsonParsed: true, stdoutJsonExact: true, stdoutJsonSchemaExact: false }],
      ['[]', { stdoutJsonParsed: true, stdoutJsonExact: true, stdoutJsonSchemaExact: false }],
      [validJson + '\n', { stdoutJsonParsed: true, stdoutJsonExact: false, stdoutJsonSchemaExact: true }],
      [Buffer.from(validJson), { stdoutType: 'buffer', stdoutBytes: Buffer.byteLength(validJson), stdoutJsonParsed: true, stdoutJsonExact: false, stdoutJsonSchemaExact: true }],
      [JSON.stringify({ ...childProof(nonce), extra: true }), { stdoutJsonParsed: true, stdoutJsonExact: true, stdoutJsonSchemaExact: false }],
    ] as Array<[unknown, Record<string, unknown>]>) {
      const generated = generatedObservation(nonce, [{ stdout }, {}]);
      expect(generated.child).toMatchObject(expected);
      expect(siwcToolEvidence(reply(generated), nonce).passed).toBe(false);
    }
  });

  it('never lets a synchronous comparison rescue a missing primary, and rejects comparison tokens', () => {
    const nonce = randomUUID();
    const missingPrimary = generatedObservation(nonce, [{ stdout: '' }, {}]);
    expect(missingPrimary.comparison.stdoutJsonSchemaExact).toBe(true);
    const failed = siwcToolEvidence(reply(missingPrimary), nonce);
    expect(failed.observed.comparisonDiagnostics).toMatchObject({ proofPassed: true });
    expect(failed.checks.childExecuted).toBe(false); expect(failed.passed).toBe(false);
    const missingComparison = generatedObservation(nonce, [{}, { stdout: '' }]);
    expect(siwcToolEvidence(reply(missingComparison), nonce).checks.childExecuted).toBe(true);
    expect(siwcToolEvidence(reply(missingComparison), nonce).passed).toBe(true); // Comparison is diagnostic, never primary evidence.
    const invalidComparisonToken = generatedObservation(nonce, [{}, { stdout: JSON.stringify({ accessTokenPresent: true, private: 'fixture-only-private' }) }]);
    expect(invalidComparisonToken.comparison.stdoutJsonSchemaExact).toBe(false);
    const observedToken = siwcToolEvidence(reply(invalidComparisonToken), nonce);
    expect(observedToken.checks.childExecuted).toBe(true);
    expect(observedToken.checks.comparisonTokenNotObserved).toBe(false); expect(observedToken.passed).toBe(false);
    expect(JSON.stringify(invalidComparisonToken)).not.toContain('fixture-only-private');
    expect(JSON.stringify(observedToken)).not.toContain('fixture-only-private');
  });

  it('projects both generated children without private stdout, stderr, nonce or probe text', () => {
    const nonce = randomUUID();
    const privateJson = JSON.stringify({ probe: 'fixture-only-private-probe', nonce: 'fixture-only-private-nonce', pid: 22, accessTokenPresent: false });
    const generated = generatedObservation(nonce, [{ stdout: 'fixture-only-private-stdout', stderr: 'fixture-only-private-stderr' }, { stdout: privateJson }]);
    expect(generated.child).toMatchObject({ stdoutBytes: Buffer.byteLength('fixture-only-private-stdout'), stdoutJsonParsed: false,
      stderrBytes: Buffer.byteLength('fixture-only-private-stderr'), stderrEmpty: false });
    expect(generated.comparison).toMatchObject({ stdoutJsonParsed: true, stdoutJsonSchemaExact: true, proof: { probe: null, nonce: null, pid: 22 } });
    expect(JSON.stringify(generated)).not.toContain('fixture-only-private');
    expect(JSON.stringify(siwcToolEvidence(reply(generated), nonce))).not.toContain('fixture-only-private');
  });

  it('keeps bounded executable and spawn diagnostics while rejecting every spawn error', () => {
    const nonce = randomUUID(), valid = proof(nonce);
    const failed = { ...valid, child: { ...valid.child, spawnError: true, spawnErrorCode: 'ENOENT',
      spawnErrorSyscall: 'spawnSync ' + SIWC_NODE_EXECUTABLE, spawnErrorMessage: 'spawnSync ' + SIWC_NODE_EXECUTABLE + ' ENOENT' } };
    const observed = siwcToolEvidence(reply(failed), nonce);
    expect(observed.passed).toBe(false);
    expect(observed.observed).toMatchObject({ childSpawnError: true, childSpawnExecutable: SIWC_NODE_EXECUTABLE,
      childSpawnErrorCode: 'ENOENT', childSpawnErrorSyscall: 'spawnSync ' + SIWC_NODE_EXECUTABLE,
      childSpawnErrorMessage: 'spawnSync ' + SIWC_NODE_EXECUTABLE + ' ENOENT' });
    const arbitrary = siwcToolEvidence(reply({ ...failed, child: { ...failed.child,
      spawnErrorCode: 'fixture-only-secret', spawnErrorSyscall: 'fixture-only-secret', spawnErrorMessage: 'fixture-only-secret', spawnExecutable: 'fixture-only-secret' } }), nonce);
    expect(arbitrary.passed).toBe(false);
    expect(arbitrary.observed).toMatchObject({ childSpawnErrorCode: 'UNKNOWN', childSpawnErrorSyscall: 'other', childSpawnErrorMessage: 'other', childSpawnExecutable: null });
    expect(JSON.stringify(arbitrary)).not.toContain('fixture-only-secret');
  });

  it('captures native spawn messages without emitting arbitrary error text', () => {
    const nonce = randomUUID();
    for (const message of ['spawnSync ' + SIWC_NODE_EXECUTABLE + ' ENOENT', 'fixture-only-private-error']) {
      let output = '';
      const socket = { destroy() {}, setTimeout() {}, once(event: string, handler: (error: { code: string }) => void) {
        if (event === 'error') handler({ code: 'EACCES' }); return this;
      } };
      const fixtureRequire = (module: string) => {
        if (module === 'node:fs') return { readFileSync() { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); } };
        if (module === 'node:net') return { connect: () => socket };
        if (module === 'node:child_process') return { spawnSync: () => ({ status: null, signal: null,
          error: Object.assign(new Error(message), { code: 'ENOENT', syscall: 'spawnSync ' + SIWC_NODE_EXECUTABLE }) }) };
        throw new Error('Unexpected fixture module');
      };
      new Script(siwcToolCommand(nonce, 30)).runInNewContext({ require: fixtureRequire, Buffer,
        process: { execPath: 'node', pid: 20, env: {}, stdout: { write(value: string) { output += value; } } } });
      expect(output).not.toContain('fixture-only-private-error');
      const observation = siwcToolEvidence(reply(JSON.parse(output)), nonce);
      expect(observation.passed).toBe(false);
      expect(observation.observed).toMatchObject({ childSpawnExecutable: SIWC_NODE_EXECUTABLE, childSpawnErrorCode: 'ENOENT',
        childSpawnErrorMessage: message.startsWith('spawnSync ') ? message : 'Child spawn error: ENOENT' });
    }
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
    expect(() => siwcChildCommand(nonce, 'other' as 'stream')).toThrow('Invalid SIWC diagnostic writer mode');
    expect(() => siwcToolCommand(nonce, 0)).toThrow('Invalid app-server PID');
    expect(() => siwcToolCommand(nonce, 42, '/tmp/alternate')).toThrow('Unreviewed SIWC socket path');
  });
});
