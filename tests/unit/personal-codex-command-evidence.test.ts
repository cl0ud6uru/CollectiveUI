import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Script } from 'node:vm';
import { COMMAND_EVIDENCE_LIMIT, collectCommandEvidence, commandEvidence, traceFixtureCommand } from '../../scripts/lib/personal-codex-command-evidence.mjs';
import { MASK_STATES, passedProbe, stockCommands } from '../../scripts/lib/personal-codex-stock-proof.mjs';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const reply = (proof: unknown, exitCode = 0, stderr = '') => ({ result: { exitCode, stdout: JSON.stringify(proof), stderr } });
const run = (source: string) => {
  const result = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', NODE_ENV: 'test' } });
  if (result.error) throw result.error;
  return { result: { exitCode: result.status, stdout: result.stdout, stderr: result.stderr } };
};

describe('synthetic command failure evidence', () => {
  it('reports actual proof fields and the exact mismatch without changing acceptance', () => {
    const cases = [
      reply({ probe: 'fixture', passed: true }),
      reply({ probe: 'different', passed: true }),
      reply({ probe: 'fixture', passed: false, detail: 'fixture mismatch' }),
      reply({ probe: 'fixture', passed: true }, 7),
      reply({ probe: 'fixture', passed: true }, 0, 'fixture advisory'),
      reply(null), reply([]), reply('fixture'),
      { result: { exitCode: 0, stdout: 'not JSON', stderr: '' } },
      { error: { code: -32000, message: 'fixture RPC rejection' } },
    ];
    for (const candidate of cases) expect(commandEvidence(candidate, 'fixture').passed).toBe(passedProbe(candidate, 'fixture'));
    expect(commandEvidence(cases[0], 'fixture').mismatches).toEqual([]);
    expect(commandEvidence(cases[1], 'fixture').mismatches).toEqual(['probe-name-mismatch']);
    expect(commandEvidence(cases[2], 'fixture')).toMatchObject({ passed: false,
      expected: { exitCode: 0, stderr: '', proof: { probe: 'fixture', passed: true }, proofKeys: ['passed', 'probe'] },
      actual: { exitCode: 0, proof: { parsed: true, fields: { probe: 'fixture', passed: false, detail: 'fixture mismatch' } } },
      mismatches: ['passed-not-true', 'proof-keys-mismatch'] });
    expect(commandEvidence(cases[3], 'fixture').mismatches).toEqual(['exit-code-not-zero']);
    expect(commandEvidence(cases[4], 'fixture').mismatches).toEqual(['stderr-not-empty']);
    expect(commandEvidence(cases[8], 'fixture')).toMatchObject({ actual: { proof: { parsed: false } }, mismatches: ['stdout-json-invalid'] });
    expect(commandEvidence(cases[9], 'fixture')).toMatchObject({ actual: { rpcError: { code: -32000, message: 'fixture RPC rejection' }, exitCode: null },
      mismatches: ['rpc-error', 'result-missing', 'exit-code-not-zero', 'stderr-not-empty', 'stdout-json-invalid'] });
  });

  it('retains every failure independently across metadata states and replacement phases', () => {
    const failures: Record<string, unknown[]> = {};
    const failedChecks = ['metadataProtected', 'activeHelperExecution', 'defaultMetadataReadOnly', 'processIsolation', 'gitExecution'];
    for (const state of MASK_STATES) {
      for (const check of failedChecks) expect(collectCommandEvidence(failures, state,
        { check, phase: 'nativeProtectionMatrix.' + check, commandSha256: 'fixture-command-hash' }, reply({ probe: check, passed: false }, 1, state + ':' + check))).toBe(false);
      expect(collectCommandEvidence(failures, state, { check: 'replacementExecution', phase: 'replacement', commandSha256: 'fixture-replacement-hash' },
        reply({ probe: 'nativeWorkspaceExecution', passed: true }), 'nativeWorkspaceExecution')).toBe(true);
      expect(failures[state]).toHaveLength(5);
      expect(failures[state]).toEqual(failedChecks.map(check => expect.objectContaining({ check, phase: 'nativeProtectionMatrix.' + check,
        passed: false, actual: expect.objectContaining({ exitCode: 1, stderr: state + ':' + check }) })));
    }
    collectCommandEvidence(failures, 'empty', { check: 'replacementExecution', phase: 'replacement', commandSha256: 'fixture-replacement-hash' },
      reply({ probe: 'nativeWorkspaceExecution', passed: true }, 1), 'nativeWorkspaceExecution');
    expect(failures.empty).toHaveLength(6);
    expect(failures.missing).toHaveLength(5);
    expect(failures.populated).toHaveLength(5);
  });

  it('redacts complete text before truncation and bounds structured projections', () => {
    const token = 'fixture-access-' + 's'.repeat(COMMAND_EVIDENCE_LIMIT * 2);
    const stderr = '\x1b[31mBearer ' + token + '\x1b[0m\nfixture-tail';
    const evidence = commandEvidence(reply({ probe: 'fixture', passed: false, api_key: token,
      detail: 'x'.repeat(COMMAND_EVIDENCE_LIMIT * 2), items: Array.from({ length: 30 }, (_, i) => i) }, 1, stderr), 'fixture');
    expect(evidence.actual.stderr).toBe('Bearer [redacted]\nfixture-tail');
    expect(evidence.actual.stderrTruncated).toBe(false);
    expect(evidence.actual.stdoutTruncated).toBe(true);
    expect(String(evidence.actual.stdout).length).toBeLessThanOrEqual(COMMAND_EVIDENCE_LIMIT);
    expect(evidence.actual.proof).toMatchObject({ parsed: true, keyCount: 5, fields: { api_key: '[redacted]',
      detail: 'x'.repeat(COMMAND_EVIDENCE_LIMIT), items: Array.from({ length: 16 }, (_, i) => i) } });
    expect(JSON.stringify(evidence)).not.toContain('fixture-access-');
    expect(JSON.stringify(evidence)).not.toContain(String.fromCharCode(27));
    const truncatedRpc = commandEvidence({ result: { exitCode: 1, stdout: '{"apiKey":"' + token, stderr: '{"authorization":"fixture-opaque-token' } }, 'fixture');
    expect(truncatedRpc.actual.stdout).toBe('{"apiKey":"[redacted]');
    expect(truncatedRpc.actual.stderr).toBe('{"authorization":"[redacted]');
  });

  it('compiles every instrumented stock fixture and leaves successful output untouched', () => {
    for (const state of MASK_STATES) for (const [probe, source] of Object.entries(stockCommands(state))) {
      expect(() => new Script(traceFixtureCommand(source, probe))).not.toThrow();
    }
    const source = "process.stdout.write(JSON.stringify({probe:'fixture',passed:true}));";
    const original = run(source), instrumented = run(traceFixtureCommand(source, 'fixture'));
    expect(instrumented).toEqual(original);
    expect(passedProbe(instrumented, 'fixture')).toBe(true);
  });

  it('preserves an uncaught failure and records EISDIR hidden by a generic assertion', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cui-command-evidence-')); directories.push(directory);
    const source = `const fs=require('node:fs');try{fs.writeFileSync(${JSON.stringify(directory)},'fixture-overwrite');}catch{throw new Error('Unexpected protected-path failure.');}`;
    expect(run(source).result.exitCode).toBe(1);
    const instrumented = run(traceFixtureCommand(source, 'metadataProtected'));
    expect(instrumented.result.exitCode).toBe(1);
    const evidence = commandEvidence(instrumented, 'metadataProtected');
    expect(evidence.passed).toBe(false);
    expect(evidence.actual.operationTraces).toEqual([expect.objectContaining({ probe: 'metadataProtected',
      error: { name: 'Error', code: null, message: 'Unexpected protected-path failure.' },
      filesystem: [expect.objectContaining({ operation: 'writeFileSync', paths: [directory], outcome: 'threw', error: expect.objectContaining({ code: 'EISDIR' }) })] })]);
  });

  it('retains helper/Git subprocess status and streams while redacting before the child stream cap', () => {
    const token = 'fixture-child-secret-' + 's'.repeat(3000);
    const child = "process.stdout.write('fixture-child-output');process.stderr.write(process.argv[1]);process.exit(7);";
    const source = `const result=require('node:child_process').spawnSync(${JSON.stringify(process.execPath)},['-e',${JSON.stringify(child)},${JSON.stringify('Bearer ' + token)}],{encoding:'utf8'});if(result.status!==7||result.stdout!=='fixture-child-output')throw new Error('Observer changed the result.');throw new Error('Git execution failed.');`;
    const evidence = commandEvidence(run(traceFixtureCommand(source, 'gitExecution')), 'gitExecution');
    expect(evidence.actual.exitCode).toBe(1);
    expect(evidence.actual.operationTraces).toEqual([expect.objectContaining({ probe: 'gitExecution', error: expect.objectContaining({ message: 'Git execution failed.' }),
      subprocesses: [expect.objectContaining({ command: process.execPath, status: 7, signal: null, error: null,
        stdout: 'fixture-child-output', stderr: 'Bearer [redacted]' })] })]);
    expect(JSON.stringify(evidence)).not.toContain('fixture-child-secret-');
  });

  it('reports malformed or RPC-truncated trace text as incomplete instead of claiming operation proof', () => {
    const evidence = commandEvidence({ result: { exitCode: 1, stdout: '', stderr: 'COLLECTIVE_FIXTURE_TRACE:{"probe":' } }, 'fixture');
    expect(evidence.actual.operationTraces).toEqual([{ parseError: 'Fixture trace was incomplete or malformed.' }]);
    expect(evidence.passed).toBe(false);
  });

  it('keeps the original failure exit status when writing the optional trace itself fails', () => {
    const source = "process.stderr.write=()=>{throw new Error('Fixture diagnostic stream closed.');};throw new Error('Fixture original failure.');";
    const original = run(source), instrumented = run(traceFixtureCommand(source, 'fixture'));
    expect(original.result.exitCode).toBe(1);
    expect(instrumented.result.exitCode).toBe(original.result.exitCode);
    expect(instrumented.result.stderr).toContain('Fixture original failure.');
    expect(commandEvidence(instrumented, 'fixture').passed).toBe(false);
  });

  it('records successful synthetic read length and fingerprint without logging file contents', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cui-command-evidence-')); directories.push(directory);
    const path = join(directory, 'fixture.txt'), sentinel = 'fixture-parent-private-read-sentinel';
    writeFileSync(path, sentinel);
    const source = `require('node:fs').readFileSync(${JSON.stringify(path)});throw new Error('Protected operation succeeded.');`;
    const evidence = commandEvidence(run(traceFixtureCommand(source, 'processIsolation')), 'processIsolation');
    expect(evidence.actual.operationTraces).toEqual([expect.objectContaining({ filesystem: [expect.objectContaining({ operation: 'readFileSync',
      paths: [path], outcome: 'returned', bytes: Buffer.byteLength(sentinel), sha256: createHash('sha256').update(sentinel).digest('hex') })] })]);
    expect(JSON.stringify(evidence)).not.toContain(sentinel);
    expect(evidence.passed).toBe(false);
  });
});
