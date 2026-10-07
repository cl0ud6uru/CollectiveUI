import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('checks native collisions and the pinned idle image supervisor with production descriptor guards', async () => {
  const result = await promisify(execFile)('/usr/bin/python3', ['-B', 'tests/fixtures/docker-hermes-processes.py'], { timeout: 10_000, maxBuffer: 128 * 1024 });
  expect(result.stderr).toContain('Ran 8 tests');
  expect(result.stderr).toContain('OK');
}, 15_000);
