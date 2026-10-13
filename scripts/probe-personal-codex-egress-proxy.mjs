// Offline smoke probe: real TLS through the proxy, synthetic certificate/data only.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { createEgressProxy } from './personal-codex-egress-proxy.mjs';
const sockets = new Set();
const track = socket => { sockets.add(socket); socket.on('error', () => {}); return socket; };
const fixture = name => readFileSync(new URL(`../tests/fixtures/personal-codex-egress/server.test-${name}`, import.meta.url));
const target = tls.createServer({ key: fixture('key'), cert: fixture('cert') }, socket => {
  track(socket); socket.on('data', data => socket.write(data));
});
let answers = ['104.18.1.1'];
let dialed = 0;
const proxy = createEgressProxy({ listenAddress: '127.0.0.1', clientAddress: '127.0.0.2',
  resolve: async () => answers,
  dial: options => { assert.equal(options.host, '104.18.1.1'); dialed++; return track(net.connect(target.address().port, '127.0.0.1')); },
});
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
async function connect(authority) {
  const socket = track(net.connect({ host: '127.0.0.1', port: proxy.address().port, localAddress: '127.0.0.2' }));
  await once(socket, 'connect'); socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  const [response] = await once(socket, 'data'); return { socket, response: response.toString() };
}
try {
  await listen(target); await listen(proxy);
  for (const host of ['auth.openai.com', 'chatgpt.com']) {
    const { socket, response } = await connect(`${host}:443`); assert.match(response, /200 Connection Established/);
    // Sole test exception: generated fixture certificate, never a live origin.
    const encrypted = track(tls.connect({ socket, servername: host, rejectUnauthorized: false }));
    await once(encrypted, 'secureConnect'); encrypted.write('synthetic-no-credentials');
    const [data] = await once(encrypted, 'data'); assert.equal(data.toString(), 'synthetic-no-credentials'); encrypted.destroy();
  }
  const { response, socket } = await connect('api.openai.com:443'); assert.match(response, /403/); socket.destroy();
  for (const [sni, addresses] of [['auth.openai.com', ['104.18.1.1']], ['chatgpt.com', ['127.0.0.1']]]) {
    answers = addresses;
    const { socket } = await connect('chatgpt.com:443'); const closed = once(socket, 'close');
    const encrypted = track(tls.connect({ socket, servername: sni, rejectUnauthorized: false }));
    await closed; encrypted.destroy(); assert.equal(dialed, 2);
  }
  process.stdout.write(`${JSON.stringify({ verified: true, authenticated: false, node: process.version,
    checks: ['both-allowed-hosts-real-tls-echo', 'unlisted-connect-denied', 'sni-mismatch-denied', 'private-dns-denied'], dialed })}\n`);
} finally {
  proxy.closeTunnels(); for (const socket of sockets) socket.destroy(); target.close(); proxy.close();
}
