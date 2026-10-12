import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { heldProcessCommand, observeProcessCommand, passedProcessObservation } from '../../scripts/lib/personal-codex-process-proof.mjs';

const directories: string[] = [], children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('independent native PID namespace proof', () => {
  it('requires a live matched process in a different namespace, not absent proc paths or a reported success alone', () => {
    const token = randomUUID(), parent = { pid: 100, pidNamespace: 'pid:[123]' };
    const valid = { ready: true, nonce: token, toolPid: 2, toolOuterPid: 120, parentOuterPid: 100, parentAlive: true,
      parentNamespace: 'pid:[123]', observerNamespace: 'pid:[123]', toolNamespace: 'pid:[456]' };
    expect(passedProcessObservation(valid, parent, token)).toBe(true);
    for (const patch of [{ toolNamespace: 'pid:[123]' }, { toolNamespace: undefined }, { parentAlive: false }, { parentOuterPid: 101 },
      { toolOuterPid: 100 }, { toolPid: 0 }, { observerNamespace: 'pid:[456]' }, { ready: false }, { nonce: randomUUID() },
      { error: { code: 'EPERM' } }, { releaseError: { code: 'EROFS' } }]) expect(passedProcessObservation({ ...valid, ...patch }, parent, token)).toBe(false);
    expect(passedProcessObservation({ passed: true }, parent, token)).toBe(false);
    expect(passedProcessObservation({ ...valid, parentOuterPid: 0 }, { ...parent, pid: 0 }, token)).toBe(false);
  });

  it('generates bounded valid scripts and rejects unreviewed nonce input', () => {
    const token = randomUUID();
    expect(() => new Script(heldProcessCommand("process.stdout.write('fixture');", token))).not.toThrow();
    expect(() => new Script(observeProcessCommand(token))).not.toThrow();
    expect(() => observeProcessCommand('../fixture')).toThrow('Invalid synthetic process nonce');
  });

  it('observes and releases a real held synthetic process, and rejects its inherited namespace', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cui-pid-proof-')); directories.push(directory);
    const token = randomUUID(), parent = { pid: process.pid, pidNamespace: readlinkSync('/proc/self/ns/pid') };
    writeFileSync(join(directory, 'fixture-parent.json'), JSON.stringify(parent));
    const local = (source: string) => source.replaceAll('/home/agent/workspace', directory);
    const child = spawn(process.execPath, ['-e', local(heldProcessCommand("process.stdout.write('fixture-released');", token))],
      { stdio: 'pipe', env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', NODE_ENV: 'test' } });
    children.push(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    const closed = new Promise<number | null>(resolve => child.on('close', resolve));
    const observed = spawnSync(process.execPath, ['-e', local(observeProcessCommand(token))], { encoding: 'utf8', timeout: 5000,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', NODE_ENV: 'test' } });
    expect(observed.error).toBeUndefined(); expect(observed.status).toBe(0);
    const observation = JSON.parse(observed.stdout);
    expect(observation).toMatchObject({ ready: true, parentAlive: true, parentNamespace: parent.pidNamespace, toolNamespace: parent.pidNamespace });
    expect(passedProcessObservation(observation, parent, token)).toBe(false);
    expect(await closed).toBe(0); expect(stdout).toBe('fixture-released'); expect(stderr).toBe('');
  });
});
