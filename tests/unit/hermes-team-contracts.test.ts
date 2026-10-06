import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import contract from '../fixtures/hermes-team-source-contract.json';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');

describe('pinned Team Bot native contract', () => {
  it('keeps native fixtures on the production bridge revision and pinned official image', async () => {
    const [bridge, lifecycle] = await Promise.all([
      readFile(path.join(root, 'src/docker-hermes/bridge.py'), 'utf8'),
      readFile(path.join(root, 'tests/sandbox/docker-hermes-native.test.ts'), 'utf8'),
    ]);
    expect(bridge).toContain(`COMMIT = '${contract.revision}'`);
    expect(lifecycle).toContain(`const PIN = '${contract.image}'`);
    expect(contract.modelAccess.enabledTeamRoutes).toEqual([]);
    expect(contract.modelAccess.officialChatgptPlanUsageVerified).toBe(false);
  });

  // Opt in with an exact source checkout and the minimal native dependencies. This
  // executes real Hermes learning/profile/routing functions, with no network/model.
  it.skipIf(!process.env.HERMES_SOURCE)('executes the hash-verified native contracts without inference', async () => {
    const { stderr } = await exec(process.env.HERMES_PYTHON ?? 'python3', [
      path.join(root, 'tests/fixtures/hermes-team-native-contract.py'),
    ], { cwd: root, timeout: 30_000, env: process.env });
    expect(stderr).toMatch(/Ran \d+ tests/);
    expect(stderr).toContain('OK');
  });

  it.skipIf(!process.env.HERMES_SOURCE)('runs the real blank Team bridge against clean pinned native profile and learning functions', async () => {
    const { stderr } = await exec(process.env.HERMES_PYTHON ?? 'python3', [
      path.join(root, 'tests/fixtures/hermes-team-pinned-bridge.py'),
    ], { cwd: root, timeout: 30_000, env: process.env });
    expect(stderr).toContain('Ran 5 tests');
    expect(stderr).toContain('OK');
  });
});
