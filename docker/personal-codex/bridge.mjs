import WebSocket from 'ws';
import { createInterface } from 'node:readline';
// Native listener is container-loopback-only. Nothing is published to the host/network.
const ws = new WebSocket('ws://127.0.0.1:4500', { maxPayload: 1024 * 1024, perMessageDeflate: false, handshakeTimeout: 8000 });
const lines = createInterface({ input: process.stdin });
lines.pause();
ws.on('open', () => lines.resume());
lines.on('line', line => { if (line.length > 1024 * 1024 || ws.readyState !== WebSocket.OPEN) process.exit(1); ws.send(line); });
ws.on('message', bytes => { if (!process.stdout.write(`${bytes}\n`)) ws.pause(); });
process.stdout.on('drain', () => ws.resume());
lines.on('close', () => { ws.close(); process.exit(0); });
ws.on('error', () => process.exit(1));
ws.on('close', () => process.exit(0));
