// Real Compose parsing, no daemon/start/pull, no operator .env and no interpolated secrets in output.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'collectiveui-widget-compose-'));
const workerImage = `example.invalid/worker@sha256:${'1'.repeat(64)}`;
const url = 'https://widgets.example.invalid/sandbox';
try {
  writeFileSync(path.join(directory, '.env'), `POSTGRES_PASSWORD=SYNTHETIC_ONLY
AUTH_URL=https://portal.example.invalid
AUTH_SECRET=SYNTHETIC_AUTH_SECRET
ENCRYPTION_KEY=SYNTHETIC_ENCRYPTION_KEY
TOOL_APPROVAL_SECRET=SYNTHETIC_APPROVAL_SECRET
MCP_APPS_HOST_ORIGIN=https://portal.example.invalid
MCP_APPS_SANDBOX_URL=${url}
COLLECTIVEUI_WEB_IMAGE=example.invalid/web@sha256:${'2'.repeat(64)}
COLLECTIVEUI_WORKER_IMAGE=${workerImage}
`);
  for (const file of ['docker-compose.yml', 'docker-compose.release.yml']) {
    copyFileSync(file, path.join(directory, file));
    const config = profile => {
      const args = ['compose', '--project-directory', directory, '--env-file', path.join(directory, '.env'), '-p', 'widget-fixture', '-f', path.join(directory, file),
        ...(profile ? ['--profile', profile] : []), 'config', '--format', 'json'];
      const result = spawnSync('docker', args, { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
      assert.equal(result.status, 0, `Compose could not parse ${file}; run docker compose version and check the fixture configuration.`);
      return JSON.parse(result.stdout);
    };
    assert.equal(config().services['mcp-app-sandbox'], undefined, `${file}: widgets must be opt-in`);
    const enabled = config('mcp-apps'), sandbox = enabled.services['mcp-app-sandbox'];
    assert.deepEqual(sandbox.environment, { MCP_APPS_HOST_ORIGIN: 'https://portal.example.invalid', MCP_APPS_SANDBOX_HOST: '0.0.0.0', MCP_APPS_SANDBOX_PORT: '3102' });
    assert.equal(enabled.services.web.environment.MCP_APPS_SANDBOX_URL, url);
    assert.equal(enabled.services.worker.environment.MCP_APPS_SANDBOX_URL, url);
    assert.equal(sandbox.user, '1000:1000'); assert.equal(sandbox.read_only, true);
    assert.deepEqual(sandbox.cap_drop, ['ALL']); assert.deepEqual(sandbox.security_opt, ['no-new-privileges:true']);
    assert.equal(sandbox.pids_limit, 32); assert.equal(Number(sandbox.mem_limit), 134217728);
    assert.equal(sandbox.cpus, 0.5); assert.ok(!sandbox.volumes?.length); assert.ok(!sandbox.depends_on);
    assert.equal(sandbox.ports[0].host_ip, '127.0.0.1'); assert.equal(sandbox.ports[0].target, 3102);
    assert.deepEqual(Object.keys(sandbox.networks), ['mcp-apps']);
    for (const service of ['web', 'worker', 'db']) assert.ok(!enabled.services[service].networks['mcp-apps']);
    assert.ok(!JSON.stringify(sandbox).includes('SYNTHETIC_'));
    if (file.includes('release')) {
      assert.equal(sandbox.image, workerImage); assert.deepEqual(sandbox.command, ['node', 'scripts/mcp-app-sandbox.mjs']);
      assert.ok(sandbox.healthcheck.test.join(' ').includes('/sandbox'));
      assert.deepEqual(Object.keys(config('maintenance').services).sort(), ['backup', 'db', 'migrate', 'web', 'worker']);
    } else assert.equal(sandbox.build.target, 'mcp-app-sandbox');
    console.log(`${file}: opt-in, origin settings and sandbox isolation verified`);
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
