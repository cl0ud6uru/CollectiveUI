import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrokerConfig } from '@/personal-codex/docker';

const fs = vi.hoisted(() => ({ lstat: vi.fn(), readFile: vi.fn() }));
vi.mock('node:fs/promises', () => fs);
const base = { socketPath: '/run/docker.sock', image: `collectiveui/personal-codex@sha256:${'a'.repeat(64)}`, namespace: 'cui-codex-test', owners: ['member-101'] };

describe('pinned operator sandbox policy', () => {
  beforeEach(() => {
    fs.lstat.mockReset().mockImplementation(async (path: string) => ({ uid: 0, mode: path.endsWith('.json') || path.endsWith('sandbox-v1') ? 0o100444 : 0o40755, isFile: () => path.endsWith('.json') || path.endsWith('sandbox-v1'), isDirectory: () => !(path.endsWith('.json') || path.endsWith('sandbox-v1')) }));
    fs.readFile.mockReset();
  });
  it('returns pinned create argv and Docker-normalized inspect options', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const { sandboxPolicy } = await import('../../src/personal-codex/sandbox-policy.mjs');
    fs.readFile.mockImplementation((path: string) => actual.readFile(`${process.cwd()}/docker/personal-codex/${path.split('/').at(-1)}`));
    const policy = await sandboxPolicy('collectiveui-sandbox-v1');
    expect(policy.create).toEqual(['no-new-privileges:true', 'apparmor=collectiveui-sandbox-v1', 'seccomp=/etc/collectiveui/security/collectiveui-seccomp-v1.json']);
    expect(policy.inspect[2]).toBe(`seccomp=${JSON.stringify(JSON.parse(await actual.readFile(`${process.cwd()}/docker/personal-codex/collectiveui-seccomp-v1.json`, 'utf8')))}`);
    expect(policy.appArmorProfile).toBe('collectiveui-sandbox-v1');
  });
  it('uses default confinement unless explicitly configured', async () => {
    const { sandboxPolicy } = await import('../../src/personal-codex/sandbox-policy.mjs');
    expect(await sandboxPolicy()).toEqual({ create: ['no-new-privileges:true'], inspect: ['no-new-privileges:true'] });
    expect(fs.lstat).not.toHaveBeenCalled();
  });
  it('rejects seccomp drift even when the AppArmor source matches', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const { sandboxPolicy } = await import('../../src/personal-codex/sandbox-policy.mjs');
    fs.readFile.mockImplementation((path: string) => path.endsWith('.json') ? Promise.resolve(Buffer.from('{}')) : actual.readFile(`${process.cwd()}/docker/personal-codex/collectiveui-sandbox-v1`));
    await expect(sandboxPolicy('collectiveui-sandbox-v1')).rejects.toThrow(/policy/);
  });
  it('pins only the exact two audited pivot paths and rejects the previous profile bytes', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const { sandboxPolicy, APPARMOR_SHA256, SECCOMP_SHA256 } = await import('../../src/personal-codex/sandbox-policy.mjs');
    const source = await actual.readFile(`${process.cwd()}/docker/personal-codex/collectiveui-sandbox-v1`, 'utf8');
    expect(source.split('\n').filter(line => line.trim().startsWith('pivot_root'))).toEqual([
      '  pivot_root oldroot=/tmp/oldroot/ /tmp/,', '  pivot_root oldroot=/newroot/ /newroot/,',
    ]);
    expect(createHash('sha256').update(source).digest('hex')).toBe(APPARMOR_SHA256);
    expect(APPARMOR_SHA256).toBe('f9f89ce0a645d5d90b326908d384ad1c0553b71003944a9628bd5c83e4c90d81');
    const previous = source.replace('  pivot_root oldroot=/newroot/ /newroot/,\n', '');
    expect(createHash('sha256').update(previous).digest('hex')).toBe('d0b2b0d205f15ed22d05bfe0e21a64947cab9ddff933652bfd22caab1789852b');
    fs.readFile.mockImplementation((path: string) => path.endsWith('.json')
      ? actual.readFile(`${process.cwd()}/docker/personal-codex/collectiveui-seccomp-v1.json`) : Promise.resolve(Buffer.from(previous)));
    await expect(sandboxPolicy('collectiveui-sandbox-v1')).rejects.toThrow(/policy/);
    expect(SECCOMP_SHA256).toBe('e077360ce81d54eb7acf5d15d20e7c9444a16c68ea50a38ac66cb8e3ccf13370');
  });
  it('rejects policy bytes that differ from the reviewed hash', async () => {
    const { sandboxPolicy } = await import('../../src/personal-codex/sandbox-policy.mjs');
    fs.readFile.mockResolvedValue(Buffer.from('{}'));
    await expect(sandboxPolicy('collectiveui-sandbox-v1')).rejects.toThrow(/policy/);
  });
  it.each(['writable file', 'writable parent', 'non-root', 'symlink'])('rejects %s before reading policy bytes', async (kind) => {
    const { sandboxPolicy } = await import('../../src/personal-codex/sandbox-policy.mjs');
    fs.lstat.mockImplementation(async (path: string) => {
      const file = path.endsWith('sandbox-v1');
      return { uid: kind === 'non-root' ? 10001 : 0,
        mode: file ? (kind === 'writable file' ? 0o100644 : 0o100444) : (kind === 'writable parent' ? 0o40777 : 0o40755),
        isFile: () => file && kind !== 'symlink', isDirectory: () => !file };
    });
    await expect(sandboxPolicy('collectiveui-sandbox-v1')).rejects.toThrow(/policy/);
    expect(fs.readFile).not.toHaveBeenCalled();
  });
  it('rejects unsupported probe executable before invoking Docker', async () => {
    const { execFileSync } = await import('node:child_process');
    expect(() => execFileSync(process.execPath, ['scripts/probe-personal-codex.mjs'], { cwd: process.cwd(), env: { NODE_ENV: 'test', PERSONAL_CODEX_DOCKER_EXECUTABLE: '/tmp/docker' }, stdio: 'pipe' })).toThrow();
  });
  it('rejects unconfined probe policy before invoking Docker', async () => {
    const { execFileSync } = await import('node:child_process');
    expect(() => execFileSync(process.execPath, ['scripts/probe-personal-codex.mjs'], { cwd: process.cwd(), env: { NODE_ENV: 'test', PERSONAL_CODEX_SANDBOX_PROFILE: 'unconfined' }, stdio: 'pipe' })).toThrow();
  });
  it('admits only the reviewed profile and fixed executable choices', () => {
    expect(BrokerConfig.parse({ ...base, sandboxProfile: 'collectiveui-sandbox-v1', dockerExecutable: '/usr/bin/docker' }).sandboxProfile).toBe('collectiveui-sandbox-v1');
    for (const sandboxProfile of ['unconfined', '/tmp/profile', { securityOpt: ['seccomp=unconfined'] }]) {
      expect(() => BrokerConfig.parse({ ...base, sandboxProfile })).toThrow();
    }
    expect(() => BrokerConfig.parse({ ...base, dockerExecutable: '/tmp/docker' })).toThrow();
  });
});
