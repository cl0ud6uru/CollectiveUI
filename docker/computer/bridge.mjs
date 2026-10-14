// Executed only by the trusted host broker through non-TTY sbx exec.
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import WebSocket from '/opt/collective-codex/node_modules/ws/wrapper.mjs';

const maxBytes = 1024 * 1024;
const ws = new WebSocket('ws://localhost/runtime', {
  createConnection: () => connect('/codex-home/computer-runtime.sock'),
  followRedirects: false, handshakeTimeout: 8000, maxPayload: maxBytes, perMessageDeflate: false,
});
process.stdin.pause();
let lines, bytes = 0;
ws.on('open', () => {
  process.stdin.on('data', chunk => {
    for (const byte of chunk) {
      bytes = byte === 10 ? 0 : bytes + 1;
      if (bytes > maxBytes) { ws.terminate(); process.exitCode = 1; return; }
    }
  });
  lines = createInterface({ input: process.stdin });
  lines.on('line', line => {
    if (Buffer.byteLength(line) > maxBytes || ws.bufferedAmount > 2 * maxBytes) ws.terminate();
    else ws.send(line);
  });
  lines.on('close', () => ws.close());
  process.stdin.resume();
});
ws.on('message', data => { if (!process.stdout.write(`${data}\n`)) ws.pause(); });
process.stdout.on('drain', () => ws.resume());
process.stdout.on('error', () => ws.terminate());
ws.on('error', () => { process.exitCode = 1; ws.terminate(); });
ws.on('close', () => { lines?.close(); process.stdin.destroy(); });
process.on('SIGTERM', () => { ws.terminate(); process.stdin.destroy(); });
