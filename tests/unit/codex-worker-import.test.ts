import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { build, type BuildFailure } from 'esbuild';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);

describe('Codex server modules in the standalone worker', () => {
  it('imports recovery and dispatch using real plain Node without Next conditions or test mocks', async () => {
    const result = await exec(process.execPath, ['--import', 'tsx', 'tests/fixtures/codex-worker-import.mjs'], {
      cwd: process.cwd(), timeout: 15000,
      env: { NODE_ENV: 'production', DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:1/fixture', PATH: process.env.PATH },
    });
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('import in the plain Node worker');
  }, 20000); // Let the subprocess's own 15-second deadline report cold-import failures first.

  it('keeps recovery and dispatch unavailable in a browser bundle', async () => {
    for (const [entry, builtin] of [['recovery', 'node:net'], ['run', 'node:async_hooks']]) {
      const failure = await build({
        stdin: { contents: `import * as worker from './src/lib/codex/${entry}'; console.log(worker);`, resolveDir: process.cwd() },
        bundle: true, platform: 'browser', write: false, logLevel: 'silent', alias: { '@': resolve('src') },
      }).then(() => null, error => error as BuildFailure);
      expect(failure?.errors).toEqual(expect.arrayContaining([expect.objectContaining({
        text: `Could not resolve "${builtin}"`, location: expect.objectContaining({ file: `src/lib/codex/${entry}.ts` }),
      })]));
    }
  });
});
