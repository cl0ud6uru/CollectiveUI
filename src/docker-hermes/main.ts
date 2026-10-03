import { createServer } from 'node:http';
import { readFile, realpath, stat, lstat, open, chmod, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { body, json, serveNative } from '../local-hermes/server';
import { LocalError } from '../local-hermes/controller';
import { DockerBroker } from './broker';
import { BrokerConfig, DockerDriver, type RuntimeDriver } from './docker';
import { ownerId } from './types';

export async function listenBroker(broker: DockerBroker) {
  // No lease survives a broker restart. Confirm retained containers are stopped before serving IPC.
  await broker.expireLeases();
  const server = createServer((req, res) => { void (async () => {
    if (req.headers.origin || req.headers.upgrade) throw new LocalError(403, 'Browser connections are not supported.');
    const owner = ownerId.parse(req.headers['x-collective-owner']);
    const url = req.url ?? '';
    if (req.method === 'GET' && url === '/admin/owners') return json(res, 200, broker.owners());
    if (req.method === 'POST' && url === '/control/lease') {
      const lease = z.object({ canCreate: z.boolean() }).strict().parse(await body(req));
      broker.authorize(owner, lease.canCreate); return json(res, 200, { renewed: true });
    }
    if (req.method === 'GET' && url === '/control/status') return json(res, 200, await broker.status(owner));
    if (req.method === 'POST' && url === '/control/enable') { broker.enable(owner); return json(res, 202, await broker.status(owner)); }
    if (req.method === 'POST' && url === '/control/stop') { await broker.stop(owner); return json(res, 200, await broker.status(owner)); }
    if (req.method === 'POST' && url === '/control/create') return json(res, 200, await broker.create(owner, await body(req)));
    if (req.method === 'POST' && url === '/control/link') return json(res, 200, await broker.link(owner, await body(req)));
    const resource = /^\/resources\/([a-f0-9]{32})$/.exec(url);
    if (req.method === 'GET' && resource) return json(res, 200, await broker.resources(owner, resource[1]));
    const match = /^\/p\/([a-f0-9]{32})(\/v1\/.*)$/.exec(url);
    if (!match) throw new LocalError(404, 'Unknown operation.');
    const cleanup = (req.method === 'POST' && /^\/v1\/runs\/run_[a-z0-9]+\/stop$/.test(match[2])) ||
      (req.method === 'GET' && /^\/v1\/runs\/run_[a-z0-9]+$/.test(match[2]));
    const { controller, nativeBindingId } = cleanup ? broker.forCleanup(owner, match[1]) : await broker.forRequest(owner, match[1]);
    await serveNative(controller, nativeBindingId, match[2], req, res);
  })().catch(e => {
    if (res.headersSent) return res.destroy();
    json(res, e instanceof LocalError ? e.status : e instanceof z.ZodError ? 400 : 503,
      { error: e instanceof LocalError ? e.message : 'Personal Hermes operation failed.' });
  }); });
  server.requestTimeout = 45000; server.headersTimeout = 10000; server.maxConnections = 128;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(broker.config.socketPath, resolve); });
  await chmod(broker.config.socketPath, 0o660);
  const leaseTimer = setInterval(() => void broker.expireLeases().catch(() => {}), 5000);
  return { close: async () => { clearInterval(leaseTimer); await broker.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
/** Called by the supervisor after process death; never removes a live or unrelated IPC endpoint. */
export async function cleanupRetainedBroker(config: BrokerConfig, driver: RuntimeDriver) {
  const lockPath = path.join(config.stateDir, 'broker.lock');
  const prior = await readFile(lockPath, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (prior) {
    const pid = z.object({ pid: z.number().int().positive() }).parse(JSON.parse(prior)).pid;
    try { process.kill(pid, 0); throw new Error('Broker is still alive'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
  }
  await new DockerBroker(config, driver).close();
  const socket = await lstat(config.socketPath).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (socket) {
    if (!prior || !socket.isSocket() || socket.uid !== process.getuid?.()) throw new Error('Unowned or unsafe stale IPC endpoint');
    await unlink(config.socketPath);
  }
  await unlink(lockPath).catch(e => { if (e.code !== 'ENOENT') throw e; });
}
async function main() {
  const cleanup = process.argv[3] === '--stop-retained';
  if (process.argv.length !== (cleanup ? 4 : 3)) throw new Error('Usage: tsx src/docker-hermes/main.ts /absolute/broker.json [--stop-retained]');
  const config = BrokerConfig.parse(JSON.parse(await readFile(process.argv[2], 'utf8')));
  for (const dir of [config.stateDir, path.dirname(config.socketPath)]) {
    if (await realpath(dir) !== dir || (await stat(dir)).mode & 0o007) throw new Error('Use canonical private state and trusted-group socket directories.');
  }
  if (await realpath(config.bridgePath) !== config.bridgePath || ((await stat(config.bridgePath)).mode & 0o022 || !((await stat(config.bridgePath)).mode & 0o004))) throw new Error('Use a trusted non-group/world-writable bridge file.');
  const lockPath = path.join(config.stateDir, 'broker.lock');
  if (cleanup) {
    await cleanupRetainedBroker(config, new DockerDriver(config));
    return;
  }
  const lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.close();
  const running = await listenBroker(new DockerBroker(config, new DockerDriver(config)));
  let closing = false;
  const close = () => { if (closing) return; closing = true; void running.close().then(async () => { await unlink(lockPath); process.exit(0); }, () => process.exit(1)); };
  process.on('SIGTERM', close); process.on('SIGINT', close);
  console.info('Personal Hermes broker listening on protected IPC; runtimes start only on authorized enable.');
}
if (process.argv[1]?.endsWith('/docker-hermes/main.ts')) void main().catch(() => { console.error('Broker startup failed. Verify private configuration, storage and exclusive ownership.'); process.exitCode = 1; });
