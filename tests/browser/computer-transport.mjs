import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
  for (const name of ['app-server.mjs', 'bridge.mjs'])
    await copyFile(join(repo, 'docker/computer', name), join(context, name));
  await cp(join(repo, 'node_modules/ws'), join(context, 'ws'), { recursive: true });
  await writeFile(join(context, 'server.mjs'), `import { createInterface } from 'node:readline';
const session = String(process.pid);
createInterface({ input: process.stdin }).on('line', line => {
  let request; try { request = JSON.parse(line); } catch { process.exit(2); }
  if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { method: request.method, session } }) + '\\n');
});
`);
  await writeFile(join(context, 'Dockerfile'), `FROM node:22-slim
USER root
RUN mkdir -p /codex-home /opt/collective-computer /opt/collective-codex/node_modules/ws
COPY app-server.mjs /opt/collective-computer/app-server.mjs
COPY bridge.mjs /opt/collective-codex/bridge.mjs
COPY server.mjs /opt/collective-codex/server.mjs
COPY ws/ /opt/collective-codex/node_modules/ws/
RUN chmod -R a+rX /opt/collective-codex/node_modules/ws \
 && chmod 0644 /opt/collective-computer/app-server.mjs /opt/collective-codex/bridge.mjs /opt/collective-codex/server.mjs \
 && chown -R 10001:10001 /codex-home
USER 10001:10001
ENTRYPOINT ["node", "/opt/collective-computer/app-server.mjs"]
`);
  docker(['build', '-f', join(context, 'Dockerfile'), '-t', image, context], {
    env: { ...process.env, BUILDX_CONFIG: buildx },
  });
  const uid = process.getuid();
  const gid = process.getgid();
  docker(['run', '-d', '--name', container, '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', `${uid}:${gid}`,
    '--mount', `type=bind,src=${codexHome},dst=/codex-home`, image]);
  containerStarted = true;
  const socketPath = join(codexHome, 'computer-runtime.sock');
  const socket = await waitForSocket(socketPath);
  assert.equal(socket.mode & 0o777, 0o600, 'UDS must be private to the container owner');
  assert.equal(socket.uid, uid, 'UDS must be owned by the runtime identity');

  const first = connectBridge();
  const second = connectBridge();
  first.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  second.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} })}\n`);
  const [one, two] = await Promise.all([waitForLine(first.child), waitForLine(second.child)]);
  assert.equal(one.id, 1);
  assert.equal(two.id, 2);
  assert.equal(one.result.method, 'initialize');
  assert.equal(two.result.method, 'initialize');
  assert.notEqual(one.result.session, two.result.session, 'each bridge must get an independent stock stdio process');
  first.child.stdin.end();
  second.child.stdin.end();

  assert.equal(await rejectedOrigin(socketPath), true, 'UDS WebSocket must reject an Origin header');
  const oversized = connectBridge();
  oversized.child.stdin.write(`${'x'.repeat(1024 * 1024 + 1)}\n`);
  const oversizedExit = await new Promise(resolve => {
    const timeout = setTimeout(() => resolve(null), 5000);
    oversized.child.once('exit', code => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(oversizedExit, 1, 'bridge must reject an oversized JSONL frame');

  const tcpListener = docker(['exec', container, 'node', '-e', `
    const fs = require('node:fs');
    const listen = ['tcp', 'tcp6'].some(name => fs.readFileSync('/proc/net/' + name, 'utf8')
      .trim().split('\\n').slice(1).some(line => line.trim().split(/\\s+/)[1]?.split(':').at(-1) === '1194' && line.trim().split(/\\s+/)[3] === '0A'));
    process.stdout.write(String(listen));
  `]);
  assert.equal(tcpListener, 'false', 'desktop app-server must not listen on TCP 4500');
  console.log('computer transport fixture: UDS, independent bridges, origin/size limits, and no TCP listener passed');
}

try {
  await main();
} finally {
  if (containerStarted) {
    spawnSync('docker', ['stop', '--time', '2', container], { encoding: 'utf8', timeout: 10_000 });
    spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8', timeout: 10_000 });
  }
  spawnSync('docker', ['image', 'rm', '-f', image], { encoding: 'utf8', timeout: 10_000 });
  await rm(temp, { recursive: true, force: true });
}
