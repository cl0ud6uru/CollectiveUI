import { spawn } from 'node:child_process';
import { chmodSync, createReadStream, lstatSync, unlinkSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, connect } from 'node:net';
import { readdir, readFile } from 'node:fs/promises';
import { prepareWorkspace } from './prepare-workspace.mjs';

const TOKEN_SOCKET = '/codex-home/.collective-codex-siwc.sock';
const TOKEN_LIMIT = 17_000;
const MAX_TOKEN_BYTES = 16_384;
const tokenFingerprint = token => createHash('sha256').update(token, 'utf8').digest('hex');

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
    else {
      while (index < text.length && text[index] !== ',' && text[index] !== '}') index += 1;
    }
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
  if (Buffer.byteLength(text, 'utf8') > TOKEN_LIMIT) throw new Error('token payload too large');
  const value = parseObject(text);
  if (Object.keys(value).length !== 2 || !Object.hasOwn(value, 'accessToken') || !Object.hasOwn(value, 'credentialBinding') ||
      typeof value.accessToken !== 'string' || Buffer.byteLength(value.accessToken, 'utf8') < 1 ||
      Buffer.byteLength(value.accessToken, 'utf8') > MAX_TOKEN_BYTES || typeof value.credentialBinding !== 'string' ||
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

async function readBounded(stream, byteLimit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > byteLimit) throw new Error('payload too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readTokenFromFd(fd) {
  const stream = createReadStream(null, { fd, autoClose: true });
  return parseTokenPayload(await readBounded(stream, TOKEN_LIMIT));
}

function exchangeTokenRequest(body) {
  return new Promise((resolve, reject) => {
    const socket = connect(TOKEN_SOCKET);
    let replied = false;
    socket.setTimeout(8000, () => socket.destroy(new Error('SIWC control request timed out')));
    socket.once('error', reject);
    socket.once('data', data => {
      replied = data.toString() === 'ok';
      socket.destroy();
      replied ? resolve() : reject(new Error('SIWC control request rejected'));
    });
    socket.once('connect', () => socket.end(body));
    socket.once('close', () => { if (!replied) reject(new Error('SIWC control socket closed without acknowledgement')); });
  });
}

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--sync-token') {
  try {
    const body = await readBounded(process.stdin, TOKEN_LIMIT);
    parseTokenPayload(body);
    await exchangeTokenRequest(body);
    process.exit(0);
  } catch { process.exit(3); }
}
if (argv.length === 1 && argv[0] === '--clear-token') {
  try { await exchangeTokenRequest('{"clear":true}'); process.exit(0); }
  catch { process.exit(3); }
}
const mode = argv.length === 1 ? argv[0] : '';
const stdio = mode === '--stdio';
const stdioToken = mode === '--stdio-token';
if ((!stdio && !stdioToken && argv.length !== 0) || (argv.length === 1 && !stdio && !stdioToken)) process.exit(1);
let initialToken;
if (stdioToken) {
  try { initialToken = await readTokenFromFd(3); }
  catch { process.exit(2); }
}

// Do not log native stdout/stderr: account errors can contain sensitive material.
chmodSync('/codex-home', 0o700);
chmodSync('/home/agent/workspace', 0o700);
prepareWorkspace();

const codexArgs = ['-c', 'projects={"/home/agent/workspace"={trust_level="untrusted"}}', '-c', 'notify=[]',
  '-c', 'features.hooks=false', '-c', 'features.shell_snapshot=false', '-c', 'features.memories=false',
  '-c', 'cli_auth_credentials_store="file"',
  '-c', 'web_search="disabled"', '-c', 'features.shell_tool=true', '-c', 'features.multi_agent=false',
  '-c', 'features.multi_agent_v2=false', '-c', 'features.plugins=false', '-c', 'features.plugin_hooks=false',
  '-c', 'features.enable_mcp_apps=false', '-c', 'features.image_generation=false',
  '-c', 'shell_environment_policy.inherit="none"', '-c', 'shell_environment_policy.filters.ACCESS_TOKEN="exclude"',
  'app-server', '--listen', stdio || stdioToken ? 'stdio://' : 'ws://127.0.0.1:4500'];
// An env-token provider is selected only for an explicitly synchronized SIWC token.
// Without that token, stock Codex manages ChatGPT device credentials and refreshes.
const siwcProviderArgs = [
  '-c', 'model_provider="openai_chatgpt_plan"', '-c', 'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
  '-c', 'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
  '-c', 'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"',
  '-c', 'model_providers.openai_chatgpt_plan.wire_api="responses"',
  '-c', 'model_providers.openai_chatgpt_plan.requires_openai_auth=false',
  '-c', 'model_providers.openai_chatgpt_plan.supports_websockets=false',
];
let accessToken = initialToken?.accessToken;
let child;
const childCloses = new WeakMap();
let restarting = false;
let stopping = false;
function childEnvironment() {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CODEX_HOME: process.env.CODEX_HOME,
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    NO_PROXY: process.env.NO_PROXY,
    ...(accessToken ? { ACCESS_TOKEN: accessToken } : {}),
  };
}
function startAppServer() {
  const args = accessToken ? [...siwcProviderArgs, ...codexArgs] : ['-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"', ...codexArgs];
  const current = spawn('codex', args, {
    stdio: stdio || stdioToken ? 'inherit' : 'ignore',
    env: childEnvironment(),
    // The desktop proxy owns an isolated process group around this wrapper and
    // every descendant; direct stock mode gives codex its own group for rotations.
    detached: process.platform !== 'win32' && !stdio && !stdioToken,
  });
  child = current;
  childCloses.set(current, new Promise(resolve => current.once('close', resolve)));
  current.once('error', () => { if (child === current && !stopping) process.exit(1); });
  current.on('exit', code => { if (child === current && !restarting && !stopping) process.exit(code ?? 1); });
}
function signalChild(target, signal) {
  if (!target) return;
  try {
    if (process.platform === 'win32' || stdio || stdioToken) {
      if (target.exitCode === null && target.signalCode === null) target.kill(signal);
    }
    else process.kill(-target.pid, signal);
  }
  catch (error) { if (error.code !== 'ESRCH') target.kill(signal); }
}
async function processGroupMembers(pgid) {
  const entries = await readdir('/proc');
  const members = [];
  await Promise.all(entries.filter(entry => /^\d+$/.test(entry)).map(async entry => {
    try {
      const stat = await readFile(`/proc/${entry}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      if (Number(fields[2]) === pgid && fields[0] !== 'Z' && fields[0] !== 'X') members.push(Number(entry));
    } catch {}
  }));
  return members;
}
async function waitForGroupExit(target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await processGroupMembers(target.pid)).length) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return !(await processGroupMembers(target.pid)).length;
}
async function stopChildTree() {
  const prior = child;
  if (!prior) return;
  signalChild(prior, 'SIGTERM');
  if (stdio || stdioToken || process.platform === 'win32') {
    await childCloses.get(prior);
    return;
  }
  if (!(await waitForGroupExit(prior, 3500))) {
    signalChild(prior, 'SIGKILL');
    if (!(await waitForGroupExit(prior, 2000))) throw new Error('app-server process tree did not stop');
  }
  // /proc can report a vanished group before Node delivers exit/close. Drain
  // that child's lifecycle before the replacement starts and rotation ends.
  await childCloses.get(prior);
}
async function replaceToken(nextToken) {
  restarting = true;
  try {
    await stopChildTree();
    accessToken = nextToken?.accessToken;
    if (!stopping && (!stdio && !stdioToken)) startAppServer();
  } finally { restarting = false; }
}

if (stdio || stdioToken) {
  startAppServer();
  process.on('SIGTERM', () => { stopping = true; signalChild(child, 'SIGTERM'); });
  process.on('SIGINT', () => { stopping = true; signalChild(child, 'SIGINT'); });
} else {
  const tokenServer = createServer({ allowHalfOpen: true }, socket => {
    const chunks = [];
    let bytes = 0;
    socket.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > TOKEN_LIMIT) { socket.destroy(); return; }
      chunks.push(Buffer.from(chunk));
    });
    socket.on('end', () => {
      void (async () => {
        if (stopping || restarting) throw new Error('token supervisor busy');
        const body = Buffer.concat(chunks).toString('utf8');
        let nextToken;
        try { parseClearPayload(body); }
        catch {
          nextToken = parseTokenPayload(body);
        }
        await replaceToken(nextToken);
        socket.end('ok');
      })().catch(() => socket.destroy());
    });
  });
  const stale = (() => { try { return lstatSync(TOKEN_SOCKET); } catch { return null; } })();
  if (stale) {
    if (!stale.isSocket() || stale.uid !== process.getuid()) process.exit(1);
    try {
      const probe = connect(TOKEN_SOCKET);
      probe.once('connect', () => { probe.destroy(); process.exit(1); });
      probe.once('error', error => {
        if (!['ECONNREFUSED', 'ENOENT'].includes(error.code)) process.exit(1);
        try { unlinkSync(TOKEN_SOCKET); } catch { process.exit(1); }
        listenTokenSocket();
      });
    } catch { process.exit(1); }
  } else listenTokenSocket();
  function listenTokenSocket() {
    tokenServer.listen(TOKEN_SOCKET, () => {
      chmodSync(TOKEN_SOCKET, 0o600);
      startAppServer();
    });
  }
  const stop = async signal => {
    if (stopping) return;
    stopping = true;
    tokenServer.close(() => { try { unlinkSync(TOKEN_SOCKET); } catch {} });
    signalChild(child, signal);
  };
  process.on('SIGTERM', () => { void stop('SIGTERM'); });
  process.on('SIGINT', () => { void stop('SIGINT'); });
}
