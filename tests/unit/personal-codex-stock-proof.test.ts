import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { allStockChecksPass, MASK_STATES, networkCommand, passedProbe, STOCK_CASE_CHECKS, stockCommands } from '../../scripts/lib/personal-codex-stock-proof.mjs';

const failure = (code: string) => Object.assign(new Error('Synthetic fixture ' + code), { code });
const evaluate = (script: string, fs: Record<string, unknown>, cp: Record<string, unknown> = {}) => {
  let stdout = '';
  runInNewContext(script, { require: (name: string) => name === 'node:fs' ? fs : cp,
    process: { env: { PATH: '/codex-home/tmp/arg0/codex-arg0fixture:/usr/bin' }, stdout: { write: (bytes: string) => { stdout += bytes; } } } }, { timeout: 100 });
  return { result: { exitCode: 0, stdout, stderr: '' } };
};

describe('stock native acceptance gate', () => {
  it('requires every protection, positive control and persistence check in every state', () => {
    const cases: Record<string, Record<string, boolean>> = Object.fromEntries(MASK_STATES.map(state =>
      [state, Object.fromEntries(STOCK_CASE_CHECKS.map(name => [name, true]))]));
    expect(allStockChecksPass(cases)).toBe(true);
    for (const name of ['nativeWorkspaceExecution', 'homeReadDenied', 'metadataProtected', 'processIsolation',
      'activeHelperExecution', 'shadowWriteIntegrity', 'backingDataUnchanged', 'networkControlReachable',
      'nativeNetworkDenied', 'replacementExecution']) {
      cases.empty[name] = false;
      expect(allStockChecksPass(cases)).toBe(false);
      cases.empty[name] = true;
    }
    delete cases.populated.stockArtifactsMatch;
    expect(allStockChecksPass(cases)).toBe(false);
    expect(allStockChecksPass({})).toBe(false);
  });
  it('generates valid fixture programs for all metadata states and both network controls', () => {
    for (const state of MASK_STATES) for (const script of Object.values(stockCommands(state))) {
      expect(() => new Function(script)).not.toThrow();
    }
    expect(() => new Function(networkCommand(false))).not.toThrow();
    expect(() => stockCommands('unrecognized')).toThrow();
  });

  it.each(MASK_STATES)('requires meaningful child-write denials despite structural root errors: %s', state => {
    const root = '/home/agent/workspace/.codex', calls: string[] = [];
    const fs = {
      readdirSync: () => { throw failure('EACCES'); }, readFileSync: () => { throw failure('EACCES'); },
      writeFileSync: (path: string) => { calls.push('write:' + path); throw failure(path === root ? 'EISDIR' : 'EROFS'); },
      mkdirSync: (path: string) => { calls.push('mkdir:' + path); throw failure(path === root ? 'EEXIST' : 'EACCES'); },
      renameSync: () => { throw failure('EBUSY'); }, unlinkSync: () => { throw failure('EISDIR'); }, rmdirSync: () => { throw failure('EBUSY'); },
    };
    expect(passedProbe(evaluate(stockCommands(state).metadataProtected, fs), 'metadataProtected')).toBe(true);
    expect(calls).toContain('write:' + root + '/new-fixture.txt');
    expect(calls).toContain('mkdir:' + root + '/new-fixture-directory');
    if (state === 'populated') expect(calls).toContain('write:' + root + '/fixture.txt');
    expect(() => evaluate(stockCommands(state).metadataProtected, { ...fs,
      writeFileSync: (path: string) => { if (path === root) throw failure('EISDIR'); } })).toThrow('Protected operation succeeded.');
    expect(() => evaluate(stockCommands(state).metadataProtected, { ...fs,
      writeFileSync: () => { throw failure('EISDIR'); } })).toThrow('Synthetic fixture EISDIR');
  });

  it('checks both public metadata directories; EBUSY is scoped to renaming their mount roots', () => {
    const writes: string[] = [], reads: string[] = [];
    const fs = { readFileSync: (path: string) => { reads.push(path); return 'fixture-public-metadata'; },
      writeFileSync: (path: string) => { writes.push(path); throw failure('EROFS'); }, renameSync: () => { throw failure('EBUSY'); } };
    expect(passedProbe(evaluate(stockCommands('empty').defaultMetadataReadOnly, fs), 'defaultMetadataReadOnly')).toBe(true);
    expect(reads).toEqual(['/home/agent/workspace/.git/fixture.txt', '/home/agent/workspace/.agents/fixture.txt']);
    expect(writes).toHaveLength(4);
    expect(() => evaluate(stockCommands('empty').defaultMetadataReadOnly, { ...fs, writeFileSync: () => { throw failure('EBUSY'); } })).toThrow('Synthetic fixture EBUSY');
    expect(() => evaluate(stockCommands('empty').defaultMetadataReadOnly, { ...fs, renameSync: () => undefined })).toThrow('Protected metadata rename succeeded.');
  });

  it('uses no stdin for no-input tools and still rejects EPERM combined with valid output and status0', () => {
    for (const check of ['activeHelperExecution', 'gitExecution']) {
      const options: unknown[] = [];
      const cp = { spawnSync: (command: string, _args: string[], option: unknown) => {
        options.push(option); return { status: 0, signal: null, stderr: '', stdout: command === 'python3' ? 'fixture-python\n' : command === 'git' ? '' : 'Usage: codex-linux-sandbox' };
      } };
      const fs = { mkdtempSync: () => '/home/agent/workspace/git-fixture-synthetic', readFileSync: () => 'ref: refs/heads/master\n' };
      expect(passedProbe(evaluate(stockCommands('empty')[check], fs, cp), check)).toBe(true);
      for (const option of options) expect(option).toMatchObject({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      expect(() => evaluate(stockCommands('empty')[check], fs, { spawnSync: () => ({ status: 0, stderr: '', stdout: 'Usage: codex-linux-sandbox', error: failure('EPERM') }) })).toThrow(/execution failed/);
    }
    expect(() => evaluate(stockCommands('empty').gitExecution, { mkdtempSync: () => '/fixture', readFileSync: () => 'not a Git repository' },
      { spawnSync: () => ({ status: 0, stderr: '', stdout: '' }) })).toThrow('Git initialization did not create a repository.');
  });
});
