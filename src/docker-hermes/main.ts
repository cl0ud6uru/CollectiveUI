import { createServer, type IncomingMessage } from 'node:http';
import { readFile, realpath, stat, lstat, open, chmod, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { body, json, serveNative } from '../local-hermes/server';
import { LocalError } from '../local-hermes/controller';
import { DockerBroker } from './broker';
import { BrokerConfig, DockerDriver, RESOURCE_PROTOCOL_BYTES, type RuntimeDriver } from './docker';
import { randomUUID } from 'node:crypto';
import { networkMode } from './network';
import { ownerId, teamAuthorization, teamEnsure, teamBotId, teamMode } from './types';

async function teamBody(req: IncomingMessage, maxBytes: number) {
  // Reject an explicitly oversized trusted IPC payload before allocating it or
  // entering a stopped-volume operation. Streaming/chunked bodies keep the same bound.
  const length = req.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new LocalError(413, 'Team resource request is too large.');
  return body(req, maxBytes);
}

/** Omitted policy in an existing installation inherits the pinned deployment, never a new default. */
export async function loadBrokerConfig(file: string): Promise<BrokerConfig> {
  const raw = JSON.parse(await readFile(file, 'utf8'));
  if (raw.network === undefined && typeof raw.stateDir === 'string') {
    const deployment = await readFile(path.join(raw.stateDir, 'deployment.json'), 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (deployment) raw.network = JSON.parse(deployment).network ?? 'none';
  }
  return BrokerConfig.parse(raw);
}

export async function listenBroker(broker: DockerBroker) {
  // No lease survives a broker restart. Confirm retained containers are stopped before serving IPC.
  await broker.recoverNetworks();
  await broker.expireLeases();
  const server = createServer((req, res) => { void (async () => {
    if (req.headers.origin || req.headers.upgrade) throw new LocalError(403, 'Browser connections are not supported.');
    const owner = ownerId.parse(req.headers['x-collective-owner']);
    const url = req.url ?? '';
    if (req.method === 'GET' && url === '/admin/ready') return json(res, 200, { ready: true });
    if (req.method === 'POST' && url === '/team/authorize') return json(res, 200, broker.authorizeTeam(owner, teamAuthorization.parse(await body(req))));
    if (req.method === 'POST' && url === '/team/revoke') return json(res, 200, await broker.revokeTeam(owner, await body(req, 96 * 1024)));
    if (req.method === 'POST' && url === '/team/ensure') {
      const grant = z.string().uuid().parse(req.headers['x-collective-team-grant']);
      return json(res, 200, await broker.ensureTeam(owner, teamEnsure.parse(await body(req)), grant));
    }
    if(req.method==='POST' && url==='/team/prepare-candidate'){
      const grant=z.string().uuid().parse(req.headers['x-collective-team-grant']);
      return json(res,200,broker.prepareTeamCandidate(owner,await teamBody(req,96*1024),grant));
    }
    if(req.method==='POST' && url==='/team/start-candidate'){
      const grant=z.string().uuid().parse(req.headers['x-collective-team-grant']);
      return json(res,200,await broker.startTeamCandidate(owner,await teamBody(req,32*1024),grant));
    }
    if(req.method==='POST' && url==='/team/renew-candidate'){
      const grant=z.string().uuid().parse(req.headers['x-collective-team-grant']);
      return json(res,200,broker.renewTeamCandidate(owner,await teamBody(req,32*1024),grant));
    }
    if(req.method==='POST' && url==='/team/retire-candidate')return json(res,200,await broker.retireTeamCandidate(owner,await teamBody(req,32*1024)));
    if (req.method === 'POST' && url === '/team/capture') {
      const grant = z.string().uuid().parse(req.headers['x-collective-team-grant']);
      return json(res, 200, await broker.captureTeamResources(owner, await teamBody(req, 96 * 1024), grant));
    }
    if (req.method === 'POST' && ['/team/inventory', '/team/member-inventory', '/team/apply', '/team/abort-update'].includes(url)) {
      const grant = z.string().uuid().parse(req.headers['x-collective-team-grant']);
      const input = await teamBody(req, ['/team/apply', '/team/abort-update'].includes(url) ? RESOURCE_PROTOCOL_BYTES : url === '/team/member-inventory' ? 2 * 1024 * 1024 : 96 * 1024);
      return json(res, 200, url === '/team/inventory' ? await broker.inventoryTeamResources(owner, input, grant)
        : url === '/team/member-inventory' ? await broker.inventoryTeamMemberResources(owner, input, grant) : url === '/team/apply' ? await broker.applyTeamMemberResources(owner, input, grant) : await broker.abortTeamMemberResources(owner, input, grant));
    }
    if (req.method === 'GET' && url === '/team/binding') {
      const bot = teamBotId.parse(req.headers['x-collective-team-bot']), mode = teamMode.parse(req.headers['x-collective-team-mode']);
      const grant = z.string().uuid().parse(req.headers['x-collective-team-grant']);
      return json(res, 200, broker.teamBinding(owner, bot, mode, grant));
    }
    if (req.method === 'POST' && url === '/control/revoke') return json(res, 200, broker.requestRevoke(owner));
    if (req.method === 'GET' && url === '/admin/networks') {
      const owners: Record<string, unknown> = {};
      const ids = broker.owners();
      for (let i = 0; i < ids.length; i += 4) await Promise.all(ids.slice(i, i + 4).map(async id => { owners[id] = await broker.networkStatus(id); }));
      return json(res, 200, { defaultMode: broker.config.network, owners });
    }
    if (req.method === 'GET' && url === '/admin/owners') return json(res, 200, broker.owners());
    if (req.method === 'POST' && url === '/control/lease') {
      const lease = z.object({ canCreate: z.boolean() }).strict().parse(await body(req));
      broker.authorize(owner, lease.canCreate); return json(res, 200, { renewed: true });
    }
    if (req.method === 'GET' && url === '/control/status') return json(res, 200, await broker.status(owner));
    if (req.method === 'GET' && url === '/control/network') return json(res, 200, await broker.networkStatus(owner));
    if (req.method === 'POST' && url === '/control/network') {
      const input = z.object({ actor: ownerId, request: z.unknown() }).strict().parse(await body(req));
      broker.requestNetwork(owner, input.request, input.actor); return json(res, 202, await broker.networkStatus(owner, false));
    }
    if (req.method === 'POST' && url === '/control/enable') { broker.enable(owner); return json(res, 202, await broker.status(owner)); }
    if (req.method === 'POST' && url === '/control/stop') { await broker.stop(owner); return json(res, 200, await broker.status(owner)); }
    if (req.method === 'POST' && url === '/control/create') return json(res, 200, await broker.create(owner, await body(req)));
    if (req.method === 'POST' && url === '/control/link') return json(res, 200, await broker.link(owner, await body(req)));
    const resource = /^\/resources\/([a-f0-9]{32})$/.exec(url);
    if (req.method === 'GET' && resource) return json(res, 200, await broker.resources(owner, resource[1]));
    const codex = /^\/codex\/([a-f0-9]{32})$/.exec(url);
    if (codex) {
      if (req.method === 'GET') return json(res, 200, await broker.codexState(owner, codex[1]));
      if (req.method === 'POST') return json(res, 200, await broker.codexMutation(owner, codex[1], await body(req)));
      throw new LocalError(405, 'Method not allowed.');
    }
    const settings = /^\/settings\/([a-f0-9]{32})(\/(?:test|network))?$/.exec(url);
    if (settings) {
      if (req.method === 'GET' && !settings[2]) return json(res, 200, await broker.profileSettings(owner, settings[1]));
      if (req.method === 'POST') return json(res, 200, settings[2] === '/network' ? await broker.checkConnectivity(owner, settings[1], await body(req)) : settings[2] ? await broker.testProfile(owner, settings[1], await body(req)) : await broker.updateProfile(owner, settings[1], await body(req)));
      throw new LocalError(405, 'Method not allowed.');
    }
    const match = /^\/p\/([a-f0-9]{32})(\/v1\/.*)$/.exec(url);
    if (!match) throw new LocalError(404, 'Unknown operation.');
    const cleanup = (req.method === 'POST' && /^\/v1\/runs\/run_[a-z0-9]+\/stop$/.test(match[2])) ||
      (req.method === 'GET' && /^\/v1\/runs\/run_[a-z0-9]+$/.test(match[2]));
    const team = req.headers['x-collective-team-bot'];
    const { controller, nativeBindingId } = team !== undefined ? await broker.forTeamRequest(owner, teamBotId.parse(team), teamMode.parse(req.headers['x-collective-team-mode']),
      match[1], z.string().uuid().parse(req.headers['x-collective-team-grant']),req.headers['x-collective-team-context']===undefined?undefined:{contextId:ownerId.parse(req.headers['x-collective-team-context']),runId:ownerId.parse(req.headers['x-collective-team-run'])}) : cleanup ? broker.forCleanup(owner, match[1]) : await broker.forRequest(owner, match[1]);
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
  const broker = new DockerBroker(config, driver);
  await broker.recoverNetworks(); // Dead broker: use exact migration identities before ordinary current-policy stop.
  await broker.close();
  const socket = await lstat(config.socketPath).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (socket) {
    if (!prior || !socket.isSocket() || socket.uid !== process.getuid?.()) throw new Error('Unowned or unsafe stale IPC endpoint');
    await unlink(config.socketPath);
  }
  await unlink(lockPath).catch(e => { if (e.code !== 'ENOENT') throw e; });
}
async function main() {
  const operation = process.argv[3], cleanup = operation === '--stop-retained';
  const networkOperation = ['--network-plan', '--network-apply', '--network-rollback'].includes(operation);
  if (process.argv.length !== (networkOperation ? 6 : cleanup ? 4 : 3)) throw new Error('Usage: tsx src/docker-hermes/main.ts /absolute/broker.json [--stop-retained | --network-plan OWNER MODE | --network-apply OWNER MODE | --network-rollback OWNER REQUEST_ID]');
  const config = await loadBrokerConfig(process.argv[2]);
  for (const dir of [config.stateDir, path.dirname(config.socketPath)]) {
    if (await realpath(dir) !== dir || (await stat(dir)).mode & 0o007) throw new Error('Use canonical private state and trusted-group socket directories.');
  }
  if (await realpath(config.bridgePath) !== config.bridgePath || ((await stat(config.bridgePath)).mode & 0o022 || !((await stat(config.bridgePath)).mode & 0o004))) throw new Error('Use a trusted non-group/world-writable bridge file.');
  const lockPath = path.join(config.stateDir, 'broker.lock');
  if (cleanup) {
    await cleanupRetainedBroker(config, new DockerDriver(config));
    return;
  }
  if (networkOperation) {
    // Preview is read-only and requires an existing pinned deployment. Apply requires a cleanly stopped broker.
    await stat(path.join(config.stateDir, 'deployment.json'));
    const owner = ownerId.parse(process.argv[4]);
    if (operation === '--network-plan') {
      const status = await new DockerBroker(config, new DockerDriver(config)).networkStatus(owner);
      console.info(JSON.stringify({ ...status, requested: networkMode.parse(process.argv[5]), restart: 'Running runtimes restart; stopped runtimes remain stopped. Native volume and profile identities are retained.' }));
      return;
    }
    if (await lstat(config.socketPath).catch(e => { if (e.code === 'ENOENT') return null; throw e; })) throw new Error('Stop the broker and confirm supervisor cleanup first');
    const guard = await open(lockPath, 'wx', 0o600);
    await guard.writeFile(JSON.stringify({ pid: process.pid })); await guard.close();
    const broker = new DockerBroker(config, new DockerDriver(config));
    const renewal = setInterval(() => broker.authorize(owner, false), 15000);
    try {
      await broker.recoverNetworks();
      const status = await broker.networkStatus(owner);
      const mode = networkMode.parse(operation === '--network-rollback' ? status.receipt?.previous : process.argv[5]);
      if (operation === '--network-rollback' && status.receipt?.requestId !== z.string().uuid().parse(process.argv[5])) throw new Error('Rollback request is stale');
      // The operator command has no IPC listener, and never enables a stopped runtime for chat.
      broker.authorize(owner, false); await broker.stop(owner);
      broker.requestNetwork(owner, { mode, revision: status.revision, requestId: randomUUID(), confirmRestart: true }, 'operator');
      const result = await broker.settleNetwork(owner); console.info(JSON.stringify(result));
      if (result.receipt?.state !== 'committed' || result.mode !== mode) throw new Error('Network change needs review');
    } finally { clearInterval(renewal); await unlink(lockPath); }
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
