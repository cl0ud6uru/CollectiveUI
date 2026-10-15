// Desktop image only: the stock app-server is never reachable on a guest TCP port.
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, connect } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { lstat, unlink, readdir, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { listenPrivateSocket } from './private-socket.mjs';
import { WebSocketServer } from '/opt/collective-codex/node_modules/ws/wrapper.mjs';

const socketPath = '/codex-home/computer-runtime.sock';
const tokenSocketPath = '/codex-home/.collective-codex-siwc.sock';
const stockServer = '/opt/collective-codex/server.mjs';
const children = new Set();
const sessions = new Map();
const maxBytes = 1024 * 1024;
const maxTokenBytes = 16_384;
const tokenRequestLimit = 17_000;
const trustedEnv = Object.fromEntries(['PATH', 'HOME', 'CODEX_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']
  .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
let accessToken;
let credentialBinding;
let rotating = false;
let stopping = false;
let containmentFailed = false;

function tokenFingerprint(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
function rejectDuplicateTopLevelKeys(text) {
  let index = 0;
  const whitespace = () => { while (/\s/.test(text[index] ?? '')) index += 1; };
  const readString = () => {
    const start = index;
    if (text[index++] !== '"') throw new Error('invalid JSON');
    while (index < text.length) {
      const char = text[index++];
      if (char === '"') return JSON.parse(text.slice(start, index));
      if (char === '\\') index += 1;
      else if (char.charCodeAt(0) < 0x20) throw new Error('invalid JSON');
    }
    throw new Error('invalid JSON');
  };
  whitespace();
  if (text[index++] !== '{') throw new Error('invalid JSON object');
  const keys = new Set();
  whitespace();
  while (text[index] !== '}') {
    const key = readString();
    if (keys.has(key)) throw new Error('duplicate JSON key');
    keys.add(key);
    whitespace();
    if (text[index++] !== ':') throw new Error('invalid JSON');
    whitespace();
    if (text[index] === '"') readString();
    else while (index < text.length && text[index] !== ',' && text[index] !== '}') index += 1;
    whitespace();
    if (text[index] === ',') { index += 1; whitespace(); continue; }
    if (text[index] !== '}') throw new Error('invalid JSON');
  }
  index += 1;
  whitespace();
  if (index !== text.length) throw new Error('trailing JSON data');
}
function parseObject(text) {
  rejectDuplicateTopLevelKeys(text);
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error('invalid JSON object');
  return value;
}
function parseTokenPayload(text) {
  if (Buffer.byteLength(text, 'utf8') > tokenRequestLimit) throw new Error('token payload too large');
  const value = parseObject(text);
  if (Object.keys(value).length !== 2 || !Object.hasOwn(value, 'accessToken') || !Object.hasOwn(value, 'credentialBinding') ||
      typeof value.accessToken !== 'string' || Buffer.byteLength(value.accessToken, 'utf8') < 1 ||
      Buffer.byteLength(value.accessToken, 'utf8') > maxTokenBytes || typeof value.credentialBinding !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.credentialBinding)) throw new Error('invalid token payload');
  const expected = Buffer.from(tokenFingerprint(value.accessToken), 'hex');
  const supplied = Buffer.from(value.credentialBinding, 'hex');
  if (!timingSafeEqual(expected, supplied)) throw new Error('token fingerprint mismatch');
  return { accessToken: value.accessToken, credentialBinding: value.credentialBinding };
}
function parseClearPayload(text) {
  const value = parseObject(text);
  if (Object.keys(value).length !== 1 || value.clear !== true) throw new Error('invalid clear request');
}

async function prepareSocket(path) {
  const parent = await lstat('/codex-home');
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || parent.mode & 0o077)
    throw new Error('Private runtime directory is unavailable.');
  const prior = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!prior) return;
  if (!prior.isSocket() || prior.uid !== process.getuid()) throw new Error('Private runtime socket collision.');
  const live = await new Promise((resolve, reject) => {
    const probe = connect(path);
    probe.setTimeout(1000, () => { probe.destroy(); reject(new Error('Private runtime socket is busy.')); });
    probe.on('connect', () => { probe.destroy(); resolve(true); });
    probe.on('error', error => {
      if (['ECONNREFUSED', 'ENOENT'].includes(error.code)) resolve(false);
      else reject(error);
    });
  });
  if (live) throw new Error('Private runtime is already running.');
  await unlink(path);
}

function groupMembers(pgid) {
  return readdir('/proc').then(async entries => {
    const members = [];
    await Promise.all(entries.filter(entry => /^\d+$/.test(entry)).map(async entry => {
      try {
        const stat = await readFile(`/proc/${entry}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
        if (Number(fields[2]) === pgid && fields[0] !== 'Z' && fields[0] !== 'X') members.push(Number(entry));
      } catch {}
    }));
    return members;
  });
}
function signalGroup(child, signal) {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') child.kill(signal); }
}
async function waitGroupGone(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await groupMembers(child.pid)).length) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return !(await groupMembers(child.pid)).length;
}
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    signalGroup(child, 'SIGKILL');
    if (await waitGroupGone(child, 1000)) return;
    throw new Error('app-server process tree did not stop');
  }
  signalGroup(child, 'SIGTERM');
  if (await waitGroupGone(child, 2500)) return;
  signalGroup(child, 'SIGKILL');
  if (await waitGroupGone(child, 2000)) return;
  throw new Error('app-server process tree did not stop');
}
function watchChild(child, ws) {
  children.add(child);
  child.stderr.resume(); // Account errors can contain credentials; never log or forward them.
  child.once('error', () => ws.terminate());
  child.once('exit', () => {
    children.delete(child);
    ws.terminate();
  });
  child.stdout.on('data', chunk => {
    for (const byte of chunk) {
      child.pendingBytes = byte === 10 ? 0 : child.pendingBytes + 1;
      if (child.pendingBytes > maxBytes) { ws.terminate(); signalGroup(child, 'SIGKILL'); return; }
    }
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    if (Buffer.byteLength(line) > maxBytes || ws.bufferedAmount > 2 * maxBytes) ws.terminate();
    else if (ws.readyState === ws.OPEN) ws.send(line);
  });
  ws.on('message', bytes => { if (!child.stdin.write(Buffer.concat([Buffer.from(bytes), Buffer.from('\n')]))) ws.pause(); });
  child.stdin.on('drain', () => ws.resume());
  child.stdin.on('error', () => ws.terminate());
  const session = { child, ws, lines, stopping: undefined };
  sessions.set(ws, session);
  const stopSession = () => {
    session.stopping ??= stopChild(child);
    // Avoid an unhandled rejection on ordinary disconnects while preserving the
    // rejected promise for token rotation's fail-closed wait.
    void session.stopping.then(
      () => { if (sessions.get(ws) === session) sessions.delete(ws); },
      () => { containmentFailed = true; rotating = true; },
    );
  };
  ws.once('close', () => {
    lines.close();
    stopSession();
  });
  ws.once('error', stopSession);
}
async function stopAllSessions() {
  const active = [...sessions.values()];
  const closes = active.map(session => session.ws.readyState === session.ws.CLOSED ? Promise.resolve() :
    new Promise(resolve => session.ws.once('close', resolve)));
  for (const session of active) session.ws.terminate();
  await Promise.all(active.map(async session => {
    session.lines.close();
    session.stopping ??= stopChild(session.child);
    await session.stopping;
    sessions.delete(session.ws);
  }));
  await Promise.all(closes);
}

await prepareSocket(socketPath);
await prepareSocket(tokenSocketPath);
const server = createHttpServer((_req, res) => { res.writeHead(404); res.end(); });
const sockets = new WebSocketServer({ noServer: true, maxPayload: maxBytes, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  if (stopping || rotating || containmentFailed || req.url !== '/runtime' || req.headers.origin || sockets.clients.size >= 8) { socket.destroy(); return; }
  sockets.handleUpgrade(req, socket, head, ws => {
    if (stopping || rotating) { ws.terminate(); return; }
    const token = accessToken === undefined ? undefined : { accessToken, credentialBinding };
    const child = spawn(process.execPath, [stockServer, token ? '--stdio-token' : '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: trustedEnv,
    });
    child.pendingBytes = 0;
    child.stdio[3].on('error', () => ws.terminate());
    watchChild(child, ws);
    if (token) child.stdio[3].end(JSON.stringify(token));
    else child.stdio[3].end();
  });
});
const tokenServer = createNetServer({ allowHalfOpen: true }, socket => {
  const chunks = [];
  let bytes = 0;
  socket.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > tokenRequestLimit) { socket.destroy(); return; }
    chunks.push(Buffer.from(chunk));
  });
  socket.on('end', () => {
    void (async () => {
      if (stopping || rotating || containmentFailed) throw new Error('token supervisor busy');
      const body = Buffer.concat(chunks).toString('utf8');
      let nextToken;
      try { parseClearPayload(body); }
      catch { nextToken = parseTokenPayload(body); }
      rotating = true;
      try {
        await stopAllSessions();
        accessToken = nextToken?.accessToken;
        credentialBinding = nextToken?.credentialBinding;
      } catch (error) {
        containmentFailed = true;
        throw error;
      } finally { if (!containmentFailed) rotating = false; }
      socket.end('ok');
    })().catch(() => socket.destroy());
  });
});
const cleanupRuntimeSocket = await listenPrivateSocket(server, socketPath);
const cleanupTokenSocket = await listenPrivateSocket(tokenServer, tokenSocketPath);

async function stop() {
  if (stopping) return;
  stopping = true;
  rotating = true;
  for (const ws of sockets.clients) ws.terminate();
  await stopAllSessions().catch(() => {});
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => tokenServer.close(resolve))]);
  await Promise.all([cleanupRuntimeSocket(), cleanupTokenSocket()]);
  process.exit(0);
}
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
