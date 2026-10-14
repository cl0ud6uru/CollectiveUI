// Desktop image only: the stock app-server is never reachable on a guest TCP port.
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { lstat, chmod, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { WebSocketServer } from '/opt/collective-codex/node_modules/ws/wrapper.mjs';

const socketPath = '/codex-home/computer-runtime.sock';
const children = new Set();
const maxBytes = 1024 * 1024;
let stopping = false;

async function prepareSocket() {
  const parent = await lstat('/codex-home');
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || parent.mode & 0o077)
    throw new Error('Private runtime directory is unavailable.');
  const prior = await lstat(socketPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!prior) return;
  if (!prior.isSocket() || prior.uid !== process.getuid()) throw new Error('Private runtime socket collision.');
  const live = await new Promise((resolve, reject) => {
    const probe = connect(socketPath);
    probe.setTimeout(1000, () => { probe.destroy(); reject(new Error('Private runtime socket is busy.')); });
    probe.on('connect', () => { probe.destroy(); resolve(true); });
    probe.on('error', error => { if (['ECONNREFUSED', 'ENOENT'].includes(error.code)) resolve(false); else reject(error); });
  });
  if (live) throw new Error('Private runtime is already running.');
  await unlink(socketPath);
}

await prepareSocket();
const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
const sockets = new WebSocketServer({ noServer: true, maxPayload: maxBytes, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  if (stopping || req.url !== '/runtime' || req.headers.origin || sockets.clients.size >= 8) { socket.destroy(); return; }
  sockets.handleUpgrade(req, socket, head, ws => {
    // Each transport gets stock initialize/initialized semantics and the same protected account/home.
    const child = spawn(process.execPath, ['/opt/collective-codex/server.mjs', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    child.stderr.resume(); // Account errors can contain credentials; never log or forward them.
    let pendingBytes = 0;
    child.stdout.on('data', chunk => {
      for (const byte of chunk) {
        pendingBytes = byte === 10 ? 0 : pendingBytes + 1;
        if (pendingBytes > maxBytes) { ws.terminate(); child.kill('SIGKILL'); return; }
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
    child.on('error', () => ws.terminate());
    child.on('exit', () => { children.delete(child); ws.terminate(); });
    let killTimer;
    const end = () => {
      lines.close(); child.stdin.end(); child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    };
    ws.once('close', end); ws.once('error', end);
    child.once('exit', () => clearTimeout(killTimer));
  });
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
await chmod(socketPath, 0o600);
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const ws of sockets.clients) ws.terminate();
  for (const child of children) child.kill('SIGTERM');
  server.close();
  await unlink(socketPath).catch(() => {});
  setTimeout(() => { for (const child of children) child.kill('SIGKILL'); process.exit(0); }, 3000).unref();
}
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
