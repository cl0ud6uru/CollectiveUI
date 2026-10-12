import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureFailure, fixtureRpc } from '../../scripts/lib/personal-codex-fixture-rpc.mjs';

const children: ChildProcessWithoutNullStreams[] = [];
const start = (source: string) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: 'pipe' });
  children.push(child); return child;
};
afterEach(() => { for (const child of children.splice(0)) { child.stdin.end(); child.kill(); } });

describe('credential-free fixture startup diagnostics', () => {
  it('retains a real metadata bootstrap error and aborts subsequent RPC without waiting for a timeout', async () => {
    const url = pathToFileURL(join(process.cwd(), 'docker/personal-codex/prepare-workspace.mjs')).href;
    const missingParent = join(tmpdir(), 'fixture-missing-parent-' + randomUUID(), 'workspace');
    const child = start(`const {prepareWorkspace}=await import(${JSON.stringify(url)});prepareWorkspace(${JSON.stringify(missingParent)});`);
    const rpc = fixtureRpc(child, { timeoutMs: 2000 });
    const reply = await rpc.request('initialize', {});
    expect(reply.error).toBeDefined();
    const failure = fixtureFailure(new Error(reply.error?.message), 'initial.initialize', rpc.snapshot());
    expect(failure).toMatchObject({ stage: 'initial.initialize', processClosed: true, processExitCode: 1, reason: 'fixture-process-exited' });
    expect(failure.startupStderr).toContain('ENOENT');
    expect(failure.startupStderr).toContain('.codex');
    expect(rpc.notify('initialized')).toBe(false);
    expect(await rpc.request('configRequirements/read', {})).toEqual({ error: { message: 'Fixture process unavailable.' } });
  });
  it('bounds and strips terminal controls from stderr while retaining exit status', async () => {
    const child = start("process.stderr.write('x'.repeat(20000));process.stderr.end('\\x1b[31mfixture-bootstrap-EACCES\\x1b[0m',()=>process.exit(17));");
    const rpc = fixtureRpc(child, { timeoutMs: 2000 });
    await rpc.request('initialize', {});
    expect(rpc.snapshot().processExitCode).toBe(17);
    expect(rpc.snapshot().startupStderr.length).toBeLessThanOrEqual(4096);
    expect(rpc.snapshot().startupStderr).toContain('fixture-bootstrap-EACCES');
    expect(rpc.snapshot().startupStderr).not.toContain(String.fromCharCode(27));
  });
  it('handles successful RPC and a live-process timeout without accepting either as a sandbox proof', async () => {
    const child = start("const {createInterface}=await import('node:readline');createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id && m.method==='initialize')process.stdout.write(JSON.stringify({id:m.id,result:{ready:true}})+'\\n');});");
    const rpc = fixtureRpc(child, { timeoutMs: 2000 });
    expect(await rpc.request('initialize', {})).toMatchObject({ result: { ready: true } });
    const timed = fixtureRpc(start('setInterval(()=>{},1000);'), { timeoutMs: 30 });
    const reply = await timed.request('initialize', {});
    expect(reply.error?.message).toContain('timed out');
    expect(fixtureFailure(new Error(reply.error?.message), 'initial.initialize', timed.snapshot()).reason).toBe('fixture-rpc-timeout');
  });
  it('preserves operation stderr and identifies the narrow pivot failure', () => {
    const failure = fixtureFailure({ status: 1, stderr: Buffer.from('bwrap: pivot_root(/newroot): Permission denied'), message: 'Fixture operation failed' }, 'nativeWorkspaceExecution');
    expect(failure).toMatchObject({ reason: 'pivot-root-denied', operationExitCode: 1 });
    expect(failure.diagnostic).toContain('pivot_root(/newroot)');
  });
  it('redacts common credential formats from synthetic diagnostic input', () => {
    const failure = fixtureFailure({ message: 'Bearer fixture-token OPENAI_API_KEY=fixture-api sk-fixture-secret {"access_token":"fixture-access","refresh_token":"fixture-refresh","id_token":"fixture-id"}' }, 'initial.initialize');
    for (const token of ['fixture-token', 'fixture-api', 'sk-fixture-secret', 'fixture-access', 'fixture-refresh', 'fixture-id']) {
      expect(failure.diagnostic).not.toContain(token);
    }
    expect(failure.diagnostic).toContain('[redacted]');
  });
});
