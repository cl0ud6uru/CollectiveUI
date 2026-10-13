// Credential-free CONNECT proxy for the pinned ChatGPT device-login runtime.
// Runs as Node in the existing stock image; no dependencies, mounts or TLS CA changes.
import http from 'node:http';
import net from 'node:net';
import { resolve4 } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';

export const ALLOWED_HOSTS = Object.freeze(['auth.openai.com', 'chatgpt.com']);
const MAX_HELLO = 65536;

export function publicIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}

// Return null for an incomplete TLS ClientHello; throw for malformed/unsupported
// data. Reassemble handshake records without decrypting or modifying TLS.
export function clientHelloSNI(bytes) {
  if (bytes.length > MAX_HELLO) throw new Error('oversize');
  let pos = 0;
  const parts = [];
  let payload = Buffer.alloc(0);
  while (pos + 5 <= bytes.length) {
    if (bytes[pos] !== 22 || bytes[pos + 1] !== 3) throw new Error('TLS required');
    const size = bytes.readUInt16BE(pos + 3);
    if (!size || size > 18432) throw new Error('invalid record');
    if (pos + 5 + size > bytes.length) return null;
    parts.push(bytes.subarray(pos + 5, pos + 5 + size));
    payload = Buffer.concat(parts);
    pos += 5 + size;
    if (payload.length < 4) continue;
    if (payload[0] !== 1) throw new Error('ClientHello required');
    const length = payload.readUIntBE(1, 3);
    if (length > MAX_HELLO - 4) throw new Error('oversize');
    if (payload.length >= length + 4) break;
  }
  if (payload.length < 4 || payload.length < payload.readUIntBE(1, 3) + 4) return null;
  const hello = payload.subarray(4, 4 + payload.readUIntBE(1, 3));
  let at = 34; // legacy_version + random
  const need = n => { if (at + n > hello.length) throw new Error('invalid hello'); };
  need(1); const session = hello[at++]; need(session); at += session;
  need(2); const ciphers = hello.readUInt16BE(at); at += 2; need(ciphers); at += ciphers;
  need(1); const compression = hello[at++]; need(compression); at += compression;
  need(2); const extensions = hello.readUInt16BE(at); at += 2;
  if (at + extensions !== hello.length) throw new Error('invalid extensions');
  let hostname;
  while (at < hello.length) {
    need(4); const type = hello.readUInt16BE(at); const length = hello.readUInt16BE(at + 2); at += 4; need(length);
    const end = at + length;
    if (type === 0) {
      if (hostname || length < 5 || hello.readUInt16BE(at) !== length - 2 || hello[at + 2] !== 0 ||
        hello.readUInt16BE(at + 3) !== length - 5) throw new Error('invalid SNI');
      hostname = hello.subarray(at + 5, end).toString('utf8').toLowerCase();
      if (!/^[a-z0-9.-]+$/.test(hostname)) throw new Error('invalid hostname');
    }
    at = end;
  }
  if (!hostname) throw new Error('SNI required');
  return hostname;
}

/** @param {{ listenAddress: string, clientAddress: string, resolve?: (hostname: string) => Promise<string[]>, dial?: (options: import('node:net').TcpNetConnectOpts) => import('node:net').Socket }} options */
export function createEgressProxy({ listenAddress, clientAddress, resolve = hostname => resolve4(hostname), dial = options => net.connect(options) }) {
  if (net.isIP(listenAddress) !== 4 || net.isIP(clientAddress) !== 4 || listenAddress === clientAddress)
    throw new Error('Exact, distinct IPv4 listener and runtime addresses required');
  const sockets = new Set();
  const server = http.createServer((_req, res) => { res.writeHead(403).end(); });
  server.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    if (socket.remoteAddress !== clientAddress) socket.destroy();
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connect', (req, client, head) => {
    const match = /^(auth\.openai\.com|chatgpt\.com):443$/.exec(req.url ?? '');
    if (!match || client.remoteAddress !== clientAddress) { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const hostname = match[1];
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    let bytes = Buffer.alloc(0);
    let upstream;
    let validating = false;
    const timer = setTimeout(() => client.destroy(), 10000);
    timer.unref();
    client.on('error', () => upstream?.destroy());
    client.on('close', () => { clearTimeout(timer); upstream?.destroy(); });
    const inspect = async chunk => {
      if (validating) return;
      try {
        bytes = Buffer.concat([bytes, chunk]);
        const sni = clientHelloSNI(bytes);
        if (sni === null) return;
        if (sni !== hostname) throw new Error('SNI mismatch');
        validating = true; client.pause(); client.removeListener('data', inspect);
        const addresses = await resolve(hostname);
        if (!addresses.length || !addresses.every(publicIPv4) || client.destroyed) throw new Error('destination denied');
        upstream = dial({ host: addresses[0], port: 443, family: 4 });
        sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
        upstream.on('error', () => client.destroy());
        upstream.once('connect', () => {
          clearTimeout(timer);
          upstream.write(bytes);
          client.pipe(upstream).pipe(client); client.resume();
        });
      } catch { client.destroy(); }
    };
    client.on('data', inspect);
    if (head.length) void inspect(head);
  });
  // Tests/operator shutdown can drain CONNECT sockets; no request logs or credentials.
  return Object.assign(server, { closeTunnels: () => { for (const socket of sockets) socket.destroy(); } });
}

export function startProxy() {
  const proxy = createEgressProxy({ listenAddress: process.env.CODEX_PROXY_LISTEN_IP, clientAddress: process.env.CODEX_PROXY_CLIENT_IP });
  proxy.listen(3128, process.env.CODEX_PROXY_LISTEN_IP);
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { proxy.closeTunnels(); proxy.close(); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startProxy();
