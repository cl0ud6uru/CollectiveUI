import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, chmod, copyFile, cp, writeFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import WebSocket from 'ws';
import { createInterface } from 'node:readline';

const repo = process.cwd();
const suffix = `${process.pid}-${Date.now()}`;
const image = `collective-computer-transport-test:${suffix}`;
const container = `collective-computer-transport-${suffix}`;
const temp = await mkdtemp(join(tmpdir(), 'collective-computer-transport-'));
const context = join(temp, 'context');
const codexHome = join(temp, 'codex-home');
let containerStarted = false;

function docker(args, options = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`docker ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function waitForLine(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('bridge response timed out')), 5000);
    const lines = createInterface({ input: child.stdout });
    lines.once('line', line => { clearTimeout(timeout); lines.close(); resolve(JSON.parse(line)); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`bridge exited before response (${code})`)); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
  });
}

function connectBridge() {
  const child = spawn('docker', ['exec', '-i', container, 'node', '/opt/collective-codex/bridge.mjs'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const errors = [];
  child.stderr.on('data', chunk => errors.push(chunk));
  return { child, errors };
}

function request(bridge, id, method) {
  bridge.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: {} })}\n`);
  return waitForLine(bridge.child);
}

function waitForExit(child, timeoutMs = 7000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('bridge did not close after token rotation')), timeoutMs);
    child.once('exit', code => { clearTimeout(timeout); resolve(code); });
  });
}

function execInput(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    const errors = [];
    child.stderr.on('data', chunk => errors.push(chunk));
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) resolve();
      else {
        const logs = spawnSync('docker', ['logs', container], { encoding: 'utf8' });
        reject(new Error(`docker exec failed (${code}): ${Buffer.concat(errors)}\\n${logs.stderr || logs.stdout}`));
      }
    });
    child.stdin.end(input);
  });
}

async function syncToken(token) {
  await execInput(['exec', '-i', container, 'node', '/opt/collective-codex/server.mjs', '--sync-token'],
    JSON.stringify({ accessToken: token, credentialBinding: createHash('sha256').update(token).digest('hex') }));
}

async function clearToken() {
  docker(['exec', container, 'node', '/opt/collective-codex/server.mjs', '--clear-token']);
}

async function rejectedTokenRequest(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let response = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('token socket response timed out')));
    socket.on('data', chunk => { response += chunk.toString(); });
    socket.once('error', reject);
    socket.once('close', () => resolve(response !== 'ok'));
    socket.once('connect', () => socket.end(payload));
  });
}

async function waitForSocket(socketPath) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const info = await lstat(socketPath);
      if (info.isSocket()) return info;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const logs = spawnSync('docker', ['logs', container], { encoding: 'utf8' });
  throw new Error(`private UDS did not appear: ${logs.stderr || logs.stdout}`);
}

async function rejectedOrigin(socketPath) {
  return new Promise(resolve => {
    const ws = new WebSocket('ws://localhost/runtime', {
      origin: 'https://untrusted.invalid',
      createConnection: () => connect(socketPath),
      handshakeTimeout: 2000,
    });
    const finish = () => resolve(true);
    ws.once('error', finish);
    ws.once('close', finish);
    ws.once('open', () => { ws.terminate(); resolve(false); });
  });
}

async function main() {
  await mkdir(context, { recursive: true });
  const buildx = join(temp, 'buildx');
  await mkdir(buildx, { recursive: true });
  await mkdir(codexHome, { mode: 0o700 });
  await chmod(codexHome, 0o700);
  const uid = process.getuid();
  const gid = process.getgid();
  for (const [source, destination] of [
    ['docker/computer/app-server.mjs', 'app-server.mjs'],
    ['src/agent-browserd/private-socket.mjs', 'private-socket.mjs'],
    ['docker/computer/bridge.mjs', 'bridge.mjs'],
    ['docker/personal-codex/server.mjs', 'server.mjs'],
    ['docker/personal-codex/prepare-workspace.mjs', 'prepare-workspace.mjs'],
  ]) await copyFile(join(repo, source), join(context, destination));
  await cp(join(repo, 'node_modules/ws'), join(context, 'ws'), { recursive: true });
  await writeFile(join(context, 'codex'), `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const session = String(process.pid);
const token = process.env.ACCESS_TOKEN;
const argvHasToken = token ? process.argv.includes(token) : false;
const hostSecretVisible = Object.hasOwn(process.env, 'HOST_SECRET');
createInterface({ input: process.stdin }).on('line', line => {
  let request; try { request = JSON.parse(line); } catch { process.exit(2); }
  if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    method: request.method, session, accessToken: token ?? null, argvHasToken, hostSecretVisible,
  } }) + '\\n');
});
`);
  await writeFile(join(context, 'Dockerfile'), `FROM node:22-slim
USER root
ARG FIXTURE_UID
ARG FIXTURE_GID
RUN mkdir -p /codex-home /home/agent/workspace /opt/collective-computer /opt/collective-codex/node_modules/ws
COPY app-server.mjs /opt/collective-computer/app-server.mjs
COPY private-socket.mjs /opt/collective-computer/private-socket.mjs
COPY bridge.mjs /opt/collective-codex/bridge.mjs
COPY server.mjs /opt/collective-codex/server.mjs
COPY prepare-workspace.mjs /opt/collective-codex/prepare-workspace.mjs
COPY ws/ /opt/collective-codex/node_modules/ws/
COPY codex /usr/local/bin/codex
RUN chmod -R a+rX /opt/collective-codex/node_modules/ws \\
 && chmod 0644 /opt/collective-computer/app-server.mjs /opt/collective-computer/private-socket.mjs /opt/collective-codex/bridge.mjs /opt/collective-codex/server.mjs /opt/collective-codex/prepare-workspace.mjs \\
 && chmod 0755 /usr/local/bin/codex \\
 && chown -R \${FIXTURE_UID}:\${FIXTURE_GID} /codex-home /home/agent
USER \${FIXTURE_UID}:\${FIXTURE_GID}
ENV HOME=/codex-home CODEX_HOME=/codex-home HOST_SECRET=fixture-host-only-secret
ENTRYPOINT ["node", "/opt/collective-computer/app-server.mjs"]
`);
  docker(['build', '--build-arg', `FIXTURE_UID=${uid}`, '--build-arg', `FIXTURE_GID=${gid}`,
    '-f', join(context, 'Dockerfile'), '-t', image, context], {
    env: { ...process.env, BUILDX_CONFIG: buildx },
  });
  docker(['run', '-d', '--name', container, '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', `${uid}:${gid}`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=32m,mode=1777',
    '--tmpfs', `/home/agent/workspace:rw,nosuid,nodev,size=32m,uid=${uid},gid=${gid},mode=0700`,
    '--mount', `type=bind,src=${codexHome},dst=/codex-home`, image]);
  containerStarted = true;
  const computerSocket = join(codexHome, 'computer-runtime.sock');
  const tokenSocket = join(codexHome, '.collective-codex-siwc.sock');
  for (const path of [computerSocket, tokenSocket]) {
    const socket = await waitForSocket(path);
    assert.equal(socket.mode & 0o777, 0o600, 'private UDS must have mode 0600');
    assert.equal(socket.uid, uid, 'private UDS must belong to the runtime identity');
  }

  const first = connectBridge();
  const second = connectBridge();
  const [one, two] = await Promise.all([request(first, 1, 'initialize'), request(second, 2, 'initialize')]);
  assert.equal(one.id, 1);
  assert.equal(two.id, 2);
  assert.equal(one.result.accessToken, null);
  assert.equal(two.result.accessToken, null);
  assert.equal(one.result.hostSecretVisible, false);
  assert.equal(two.result.hostSecretVisible, false);
  assert.notEqual(one.result.session, two.result.session, 'each bridge must get an independent stock stdio process');
  assert.equal(await rejectedOrigin(computerSocket), true, 'computer UDS WebSocket must reject Origin');

  const tokenOne = 'fixture-only-authorized-token-one';
  await syncToken(tokenOne);
  await Promise.all([waitForExit(first.child), waitForExit(second.child)]);
  const tokenBridge = connectBridge();
  const tokenResponse = await request(tokenBridge, 3, 'initialize');
  assert.equal(tokenResponse.result.accessToken, tokenOne, 'stock app-server child must receive the synchronized token');
  assert.equal(tokenResponse.result.argvHasToken, false, 'token must never appear in stock app-server argv');
  assert.equal(tokenResponse.result.hostSecretVisible, false, 'stock app-server environment must exclude untrusted host variables');

  const invalidBinding = JSON.stringify({ accessToken: 'rejected-token', credentialBinding: '0'.repeat(64) });
  assert.equal(await rejectedTokenRequest(tokenSocket, invalidBinding), true,
    'the protected token socket must reject a mismatched token fingerprint');
  const duplicateKey = `{"accessToken":"first","accessToken":"second","credentialBinding":"${createHash('sha256').update('second').digest('hex')}"}`;
  assert.equal(await rejectedTokenRequest(tokenSocket, duplicateKey), true,
    'the protected token socket must reject duplicate JSON keys');
  const afterInvalid = await request(tokenBridge, 30, 'initialize');
  assert.equal(afterInvalid.result.accessToken, tokenOne,
    'invalid token requests must leave the active token unchanged');

  const tokenTwo = 'fixture-only-authorized-token-two';
  await syncToken(tokenTwo);
  await waitForExit(tokenBridge.child);
  const rotatedBridge = connectBridge();
  const rotated = await request(rotatedBridge, 4, 'initialize');
  assert.equal(rotated.result.accessToken, tokenTwo, 'rotated token must be visible only to the new stock app-server child');
  assert.equal(rotated.result.argvHasToken, false);
  assert.equal(rotated.result.hostSecretVisible, false);

  await clearToken();
  await waitForExit(rotatedBridge.child);
  const clearedBridge = connectBridge();
  const cleared = await request(clearedBridge, 5, 'initialize');
  assert.equal(cleared.result.accessToken, null, 'clear must remove the in-memory token before acknowledgement');
  assert.equal(cleared.result.hostSecretVisible, false);

  const oversized = connectBridge();
  oversized.child.stdin.write(`${'x'.repeat(1024 * 1024 + 1)}\\n`);
  const oversizedExit = await waitForExit(oversized.child);
  assert.equal(oversizedExit, 1, 'bridge must reject an oversized JSONL frame');

  const tcpListener = docker(['exec', container, 'node', '-e', `
    const fs = require('node:fs');
    const listen = ['tcp', 'tcp6'].some(name => fs.readFileSync('/proc/net/' + name, 'utf8')
      .trim().split('\\n').slice(1).some(line => line.trim().split(/\\s+/)[1]?.split(':').at(-1) === '1194' && line.trim().split(/\\s+/)[3] === '0A'));
    process.stdout.write(String(listen));
  `]);
  assert.equal(tcpListener, 'false', 'desktop app-server must not listen on TCP 4500');
  clearedBridge.child.stdin.end();
  console.log('computer transport fixture: real stock wrapper, fd3 token isolation/rotation/clear, UDS, limits, and no TCP listener passed');
}

try {
  await main();
} finally {
  if (containerStarted) {
    spawnSync('docker', ['stop', '--time', '8', container], { encoding: 'utf8', timeout: 15_000 });
    spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8', timeout: 10_000 });
  }
  spawnSync('docker', ['image', 'rm', '-f', image], { encoding: 'utf8', timeout: 10_000 });
  await rm(temp, { recursive: true, force: true });
}
