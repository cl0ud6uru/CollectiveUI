// Disposable network=none fixture, against an already installed full local image ID.
// Embed synthetic files because a remote Docker daemon cannot bind this checkout.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const image = process.argv[2];
if (!/^sha256:[a-f0-9]{64}$/.test(image ?? '')) throw new Error('Complete installed local image ID required');
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
const source = readFileSync(new URL('./personal-codex-egress-proxy.mjs', import.meta.url), 'utf8');
let probe = readFileSync(new URL('./probe-personal-codex-egress-proxy.mjs', import.meta.url), 'utf8');
probe = probe.replace("'./personal-codex-egress-proxy.mjs'", JSON.stringify(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));
const fixtures = Object.fromEntries(['key', 'cert'].map(name => [name, readFileSync(new URL(`../tests/fixtures/personal-codex-egress/server.test-${name}`, import.meta.url), 'base64')]));
probe = probe.replace(/const fixture = name => .*;/, `const fixture = name => Buffer.from(${JSON.stringify(fixtures)}[name], 'base64');`);
let container;
try {
  const [installed] = JSON.parse(docker(['image', 'inspect', image])); assert.equal(installed.Id, image);
  container = docker(['create', '--pull=never', '--network', 'none', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges=true',
    '--user', '10001:10001', '--pids-limit', '64', '--memory', '128m', '--memory-swap', '128m', image, 'node', '--input-type=module', '-e', probe]).trim();
  const [inspected] = JSON.parse(docker(['inspect', container]));
  assert.equal(inspected.Config.Image, image); assert.equal(inspected.Image, image); assert.deepEqual(inspected.Mounts, []);
  const result = JSON.parse(docker(['start', '-a', container]));
  const [finished] = JSON.parse(docker(['inspect', container])); assert.equal(finished.State.ExitCode, 0); assert.equal(result.verified, true);
  process.stdout.write(`${JSON.stringify({ ...result, image, requestedAndActualImageMatch: true, network: 'none', mounts: 0 })}\n`);
} finally { if (container) docker(['rm', '-f', container]); }
