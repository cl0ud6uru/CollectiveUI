import { afterEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createEgressProxy, clientHelloSNI, publicIPv4 } from '../../scripts/personal-codex-egress-proxy.mjs';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const port = (server: net.Server) => (server.address() as net.AddressInfo).port;
async function listen(server: net.Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => { server.close(); });
  return port(server);
}
async function connect(proxyPort: number, authority: string) {
  const socket = net.connect({ port: proxyPort, host: '127.0.0.1', localAddress: '127.0.0.2' }); cleanup.push(() => socket.destroy());
  await once(socket, 'connect');
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  const [response] = await once(socket, 'data');
  return { socket, response: response.toString() };
}
async function hello(hostname: string) {
  const receiver = net.createServer(); const p = await listen(receiver);
  const accepted = once(receiver, 'connection');
  const client = tls.connect({ host: '127.0.0.1', port: p, servername: hostname, rejectUnauthorized: false });
  client.on('error', () => {}); cleanup.push(() => client.destroy());
  const [socket] = await accepted; cleanup.push(() => socket.destroy());
  const [bytes] = await once(socket, 'data');
  client.destroy(); socket.destroy();
  return bytes as Buffer;
}
function proxy(resolve = vi.fn(async () => ['104.18.1.1']), dial = vi.fn((options: net.TcpNetConnectOpts) => net.connect(options))) {
  const server = createEgressProxy({ listenAddress: '127.0.0.1', clientAddress: '127.0.0.2', resolve, dial });
  cleanup.push(() => server.closeTunnels());
  return { server, resolve, dial };
}

describe('credential-free pinned Codex TLS egress', () => {
  it.each(['auth.openai.com', 'chatgpt.com'])('passes an actual TLS round trip for %s through CONNECT', async hostname => {
    const target = tls.createServer({
      key: readFileSync('tests/fixtures/personal-codex-egress/server.test-key'),
      cert: readFileSync('tests/fixtures/personal-codex-egress/server.test-cert'),
    }, socket => { cleanup.push(() => socket.destroy()); socket.on('data', data => socket.write(data)); });
    const targetPort = await listen(target);
    const { server, resolve, dial } = proxy(undefined, vi.fn(() => net.connect(targetPort, '127.0.0.1')));
    const { socket, response } = await connect(await listen(server), `${hostname}:443`);
    expect(response).toContain('200 Connection Established');
    // Self-signed fixture only; production TLS remains end-to-end with native CA validation.
    const encrypted = tls.connect({ socket, servername: hostname, rejectUnauthorized: false });
    cleanup.push(() => encrypted.destroy()); await once(encrypted, 'secureConnect');
    encrypted.write('synthetic-no-credential-payload');
    const [echo] = await once(encrypted, 'data');
    expect(echo.toString()).toBe('synthetic-no-credential-payload');
    expect(resolve).toHaveBeenCalledWith(hostname);
    expect(dial).toHaveBeenCalledWith({ host: '104.18.1.1', port: 443, family: 4 });
  });

  it.each(['api.openai.com:443', 'auth.openai.com:80', 'auth.openai.com.evil.invalid:443', '127.0.0.1:443', 'chatgpt.com:444'])('denies %s before DNS or dial', async authority => {
    const { server, resolve, dial } = proxy();
    const { response } = await connect(await listen(server), authority);
    expect(response).toContain('403'); expect(resolve).not.toHaveBeenCalled(); expect(dial).not.toHaveBeenCalled();
  });
  it('rejects plaintext HTTP forwarding', async () => {
    const { server, resolve, dial } = proxy();
    const socket = net.connect({ port: await listen(server), host: '127.0.0.1', localAddress: '127.0.0.2' }); cleanup.push(() => socket.destroy());
    await once(socket, 'connect'); socket.write('GET http://chatgpt.com/ HTTP/1.1\r\nHost: chatgpt.com\r\n\r\n');
    const [response] = await once(socket, 'data');
    expect(response.toString()).toContain('403'); expect(resolve).not.toHaveBeenCalled(); expect(dial).not.toHaveBeenCalled();
  });
  it('rejects a client with a different source IP before CONNECT', async () => {
    const { server, resolve, dial } = proxy();
    const socket = net.connect(await listen(server), '127.0.0.1'); cleanup.push(() => socket.destroy());
    await once(socket, 'close');
    expect(resolve).not.toHaveBeenCalled(); expect(dial).not.toHaveBeenCalled();
  });
  it('denies a different TLS SNI inside an allowed CONNECT tunnel', async () => {
    const { server, resolve, dial } = proxy();
    const { socket } = await connect(await listen(server), 'chatgpt.com:443');
    const closed = once(socket, 'close'); socket.write(await hello('auth.openai.com')); await closed;
    expect(resolve).not.toHaveBeenCalled(); expect(dial).not.toHaveBeenCalled();
  });
  it.each([['127.0.0.1'], ['10.0.0.1'], ['169.254.169.254'], ['104.18.1.1', '192.168.1.1'], []].map(addresses => ({ addresses })))('denies non-public or empty DNS answer $addresses', async ({ addresses }) => {
    const { server, dial } = proxy(vi.fn(async () => addresses));
    const { socket } = await connect(await listen(server), 'chatgpt.com:443');
    const closed = once(socket, 'close'); socket.write(await hello('chatgpt.com')); await closed;
    expect(dial).not.toHaveBeenCalled();
  });
  it('handles fragmented TLS records and rejects oversized or plaintext prefaces', async () => {
    const bytes = await hello('chatgpt.com');
    expect(clientHelloSNI(bytes.subarray(0, 10))).toBeNull();
    const payload = bytes.subarray(5);
    const record = (body: Buffer) => { const h = Buffer.from([22, 3, 1, 0, 0]); h.writeUInt16BE(body.length, 3); return Buffer.concat([h, body]); };
    expect(clientHelloSNI(Buffer.concat([record(payload.subarray(0, 20)), record(payload.subarray(20))]))).toBe('chatgpt.com');
    expect(() => clientHelloSNI(Buffer.alloc(65537))).toThrow();
    expect(() => clientHelloSNI(Buffer.from('GET / HTTP/1.1'))).toThrow();
  });
  it('accepts only public IPv4 destinations', () => {
    for (const address of ['::1', '0.1.2.3', '10.1.2.3', '127.0.0.1', '100.64.0.1', '169.254.1.1', '172.16.1.1', '192.168.1.1', '198.18.0.1', '224.0.0.1']) expect(publicIPv4(address)).toBe(false);
    expect(publicIPv4('104.18.1.1')).toBe(true);
  });
});
