import { EnrollmentJournal, enrollmentReadiness } from './enrollment';
import { z } from 'zod';
import { createServer } from 'node:http';
import { chmod, mkdir, lstat, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { WebSocketServer, type WebSocket } from 'ws';
import { PersonalCodexDriver, runtimeKey } from './docker';
import type { PersonalCodexRuntimeDriver } from './driver';
import { enrollmentRequest, ownerId, pendingLogin, nativeAccount, tokenSyncRequest, tokenFingerprint, type BrokerStatus } from './contracts';
import { CodexClient } from '../lib/codex/client';
import type { CodexRuntime } from '../lib/codex/runtime';
import { ComputerController, handleComputerRequest } from './computer';
import { SbxPersonalCodexDriver } from './sbx';
import { SandboxAdminController, SandboxAdminError } from './admin';
import { SandboxAdminAction, unavailableAdminSnapshot } from './admin-contracts';

/** Protected Unix socket only. Socket access grants server authority; never mount it in an agent runtime. */
export async function startPersonalBroker(driver: PersonalCodexRuntimeDriver, enrollmentJournal?: EnrollmentJournal) {
  const dockerDriver = driver instanceof PersonalCodexDriver ? driver : null;
  const enrollment = dockerDriver ? enrollmentJournal ?? new EnrollmentJournal(dockerDriver) : null;
  if (enrollmentJournal && !dockerDriver) throw new Error('Consent enrollment is supported only by the Docker backend.');
  const computer = new ComputerController(driver);
  const socketPath = driver.config.socketPath;
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o750 });
  // Refuse stale/symlink collisions rather than deleting someone else's socket.
  if (await lstat(socketPath).catch(() => null)) throw new Error('Personal Codex socket already exists; reconcile the previous broker first.');
  const parent = await lstat(dirname(socketPath));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o007 || parent.mode & 0o020)
    throw new Error('Personal Codex socket directory must be protected from untrusted access/writes.');
  await enrollment?.load();
  const loginMarker = (owner: string) => join(dirname(socketPath), `codex-login-${runtimeKey(owner)}.pending`);
  const clearMarker = (owner: string) => unlink(loginMarker(owner)).catch(() => {});
  const hasMarker = async (owner: string) => !!await lstat(loginMarker(owner)).catch(() => null);
  const sessions = new Map<string, { client: CodexClient; login?: ReturnType<typeof pendingLogin.parse>; until?: number; completed: Set<string>; verified: boolean }>();
  // Non-secret fingerprint is deliberately ephemeral; a broker restart requires a fresh sync.
  const tokenBindings = new Map<string, string>();
  const tokenGenerations = new Map<string, number>();
  const ownerBridges = new Map<string, Set<WebSocket>>();
  const usesSIWC = () => driver instanceof SbxPersonalCodexDriver || driver.config.siwcSandboxVerified === true;
  const invalidateTokenBinding = (owner: string) => {
    tokenBindings.delete(owner);
    tokenGenerations.set(owner, (tokenGenerations.get(owner) ?? 0) + 1);
    if (usesSIWC()) for (const bridge of ownerBridges.get(owner) ?? []) bridge.terminate();
  };
  const siwcVerified = (owner: string) => driver instanceof SbxPersonalCodexDriver
    ? driver.siwcVerified(owner) : Promise.resolve(driver.config.siwcSandboxVerified);
  const siwcStatus = async (owner: string) => await siwcVerified(owner)
    ? { available: true, ...(tokenBindings.has(owner) ? { credentialBinding: tokenBindings.get(owner)! } : { reason: 'Token synchronization is required for this broker session.' }) }
    : { available: false, reason: 'An operator must verify the stock sandbox shell environment and /proc isolation proof.' };
  const queue = new Map<string, Promise<unknown>>();
  const ownerAccess = async (owner: string) => driver instanceof SbxPersonalCodexDriver && driver.config.adminEnabled
    ? driver.adminOwnerAccess(owner)
    : dockerDriver
      ? { known: dockerDriver.admitted(owner), admitted: dockerDriver.admitted(owner) }
      : { known: driver.config.owners.includes(owner), admitted: driver.config.owners.includes(owner) };
  type BridgeAuthority = { siwc: boolean; fingerprint: string | undefined; generation: number };
  const bridgeAuthorityNow = (owner: string, siwc: boolean, expected?: BridgeAuthority): BridgeAuthority => {
    // No await may separate this admission/fingerprint check from handleUpgrade.
    if (usesSIWC() !== siwc || !(driver.admitted?.(owner) ?? driver.config.owners.includes(owner))) throw new Error('Runtime unavailable');
    const current = { siwc, fingerprint: tokenBindings.get(owner), generation: tokenGenerations.get(owner) ?? 0 };
    if ((siwc && !current.fingerprint) || (expected &&
        (current.siwc !== expected.siwc || current.fingerprint !== expected.fingerprint || current.generation !== expected.generation)))
      throw new Error('Runtime unavailable');
    return current;
  };
  const authorizeBridge = async (owner: string, expected?: BridgeAuthority) => {
    const siwc = usesSIWC();
    if (siwc && !(await siwcVerified(owner))) throw new Error('Runtime unavailable');
    return bridgeAuthorityNow(owner, siwc, expected);
  };
  const admin = driver instanceof SbxPersonalCodexDriver && driver.config.adminEnabled
    ? new SandboxAdminController(driver, {
      runtimeState: async owner => {
        const running = (await driver.inspect(owner))?.State.Running === true;
        if (!running) invalidateTokenBinding(owner);
        return { credentialState: !await siwcVerified(owner) ? 'operator_unverified' : tokenBindings.has(owner) ? 'synchronized' : 'sync_required',
          computer: await computer.adminStatus(owner) };
      },
      lifecycle: async (owner, operation) => {
        const prior = queue.get(owner) ?? Promise.resolve();
        const next = prior.catch(() => {}).then(async () => {
          if (operation === 'stop' || operation === 'delete') {
            invalidateTokenBinding(owner);
            sessions.get(owner)?.client.close(); sessions.delete(owner);
            for (const bridge of ownerBridges.get(owner) ?? []) bridge.terminate();
            await computer.stopRuntime(owner, async () => {
              if (!driver.stop || operation === 'delete' && !driver.cleanup) throw new Error('Runtime lifecycle is unavailable.');
              await driver.stop(owner);
              if (operation === 'delete') await driver.cleanup!(owner);
            });
            await clearMarker(owner);
          } else {
            await computer.agentOperation(owner, async () => {
              if (!(await driver.inspect(owner))?.State.Running) invalidateTokenBinding(owner);
              if (operation === 'provision') await driver.ensure(owner);
              else await driver.startRetained(owner);
            });
          }
        });
        queue.set(owner, next);
        try { await next; } finally { if (queue.get(owner) === next) queue.delete(owner); }
      },
    }) : null;
  const runtime = (owner: string): CodexRuntime => ({ id: `personal:${owner}`, ownerId: owner, funding: 'chatgpt_subscription',
    endpoint: 'ws://127.0.0.1/runtime', tokenFile: '', isolationId: driver.name(owner), credentialBinding: 'connection-management',
    cwd: '/home/agent/workspace', isolated: true, nativeMcpDisabled: true, managed: true, socketPath });
  async function accountClient(owner: string, requireExecution = true) {
    let session = sessions.get(owner);
    if (!session) {
      // Bounded readiness wait after an explicitly requested start; no background provisioning.
      let client: CodexClient | undefined;
      for (let i = 0; i < 15; i++) {
        try { client = await CodexClient.connect(runtime(owner)); break; } catch { await new Promise(r => setTimeout(r, 200)); }
      }
      if (!client) throw new Error('Runtime did not become ready');
      session = { client, completed: new Set(), verified: false }; sessions.set(owner, session);
      client.onFailure(() => { if (sessions.get(owner)?.client === client) sessions.delete(owner); });
      client.onNotification(e => {
        if (e.method !== 'account/login/completed') return;
        const completed = z.object({ loginId: z.string().nullable(), success: z.boolean() }).safeParse(e.params);
        if (!completed.success || !completed.data.loginId) return;
        session!.completed.add(completed.data.loginId);
        if (session!.completed.size > 32) session!.completed.delete(session!.completed.values().next().value!);
        if (session!.login?.loginId === completed.data.loginId) { session!.login = undefined; void clearMarker(owner); }
      });
    }
    if (requireExecution && !session.verified) {
      try {
        const result = z.object({ exitCode: z.literal(0), stdout: z.literal('collective-codex-sandbox-ready'), stderr: z.string() }).parse(await session.client.request('command/exec', {
          command: ['sh', '-c', 'test ! -r /codex-home/auth.json && test ! -r /proc/1/root/codex-home/auth.json && probe=$(mktemp /home/agent/workspace/.collective-probe.XXXXXX) && printf collective-codex-sandbox-ready > "$probe" && cat "$probe" && rm "$probe"'],
          cwd: '/home/agent/workspace', permissionProfile: 'collective-personal', timeoutMs: 5000, outputBytesCap: 2048,
        }));
        if (result.stderr) throw new Error('Native sandbox probe failed');
      } catch { throw new Error('Native sandbox probe failed; runtime cannot be connected.'); }
      session.verified = true;
    }
    if (session.until && session.until <= Date.now() && session.login) {
      await session.client.request('account/login/cancel', { loginId: session.login.loginId }); session.login = undefined; await clearMarker(owner);
    }
    return session;
  }
  async function status(owner: string): Promise<BrokerStatus> {
    const c = await driver.inspect(owner);
    // An ephemeral binding cannot remain trusted after a runtime has stopped or disappeared.
    if (!c || !c.State.Running) invalidateTokenBinding(owner);
    const capability = driver.config.siwcSandboxVerified ? { siwc: await siwcStatus(owner) } : {};
    if (!c) return { state: 'not_started', ...capability };
    if (!c.State.Running) return { state: 'stopped', ...capability };
    // In SIWC mode, runtime readiness is the credential binding, not native account/read fields.
    if (driver.config.siwcSandboxVerified) return { state: 'running', ...capability };
    const session = await accountClient(owner, false);
    // Explicit projection strips all unexpected fields; never relay raw errors or auth material.
    const account = nativeAccount.parse(await session.client.request('account/read', { refreshToken: false }));
    if (!session.login && account.account && account.workspaceRouting) await clearMarker(owner);
    return { state: 'running', account, ...(session.login ? { login: session.login } : await hasMarker(owner) ? { loginUncertain: true } : {}), ...capability };
  }
  const server = createServer((req, res) => {
    const reply = (value: unknown, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    const isTokenSync = req.url === '/sync-token';
    void (async () => {
      // This socket is only shared with trusted portal/worker services. The portal must verify a
      // current administrator for every call; these routes are never exposed as browser endpoints.
      if (req.url?.startsWith('/admin/')) {
        if (req.url === '/admin/snapshot' && req.method === 'GET') {
          return reply(admin ? await admin.snapshot() : unavailableAdminSnapshot(
            driver instanceof SbxPersonalCodexDriver
              ? 'Ask your host operator to enable adminEnabled in the protected SBX broker configuration.'
              : 'This broker uses Docker workspaces. Configure the SBX backend to manage Docker Sandboxes here.',
            driver instanceof SbxPersonalCodexDriver ? 'sbx' : 'docker'));
        }
        if (req.url !== '/admin/action' || req.method !== 'POST') return reply({ error: 'Unknown admin operation.', code: 'unknown_action' }, 404);
        if (!admin) return reply({ error: 'Docker Sandboxes administration is not enabled.', code: 'admin_unavailable' }, 503);
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 20_000) return reply({ error: 'The admin request is too large.', code: 'invalid_request' }, 413);
          chunks.push(Buffer.from(chunk));
        }
        const body = z.object({ actorId: ownerId, request: SandboxAdminAction }).strict().safeParse(
          (() => { try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; } })());
        if (!body.success) return reply({ error: 'The admin request is invalid.', code: 'invalid_request' }, 400);
        return reply(await admin.act(body.data.request, body.data.actorId));
      }
      const owner = ownerId.parse(req.headers['x-collective-owner']);
      const access = await ownerAccess(owner);
      const preparing = req.url === '/prepare' && req.method === 'POST';
      if ((req.url === '/readiness' && req.method === 'GET') || (preparing && !dockerDriver)) {
        if (dockerDriver) return reply(await enrollmentReadiness(dockerDriver, owner));
        // SBX admission belongs to protected operator/admin policy. This endpoint
        // never imports Docker consent receipts, provisions a VM, or enables self enrollment.
        return reply({ state: 'operator_setup_required', selfEnrollment: false, enrolled: access.admitted,
          reason: 'SBX runtime preparation is operator managed; self enrollment is unavailable.' });
      }
      if ((!access.known || !access.admitted && !['/status', '/disconnect'].includes(req.url ?? '')) &&
          !(preparing && dockerDriver?.config.allowSelfEnrollment))
        return reply({ error: 'This account is not enrolled in Personal Codex.', code: 'not_enrolled' }, 403);
      if (!preparing) driver.name(owner);
      if (req.url?.startsWith('/computer/')) return handleComputerRequest(computer, req, res, owner);
      const action = req.url?.slice(1);
      let consent: ReturnType<typeof enrollmentRequest.parse> | undefined;
      if (preparing) {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 2048) throw new Error(); chunks.push(Buffer.from(chunk)); }
        consent = enrollmentRequest.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      }
      let sync: ReturnType<typeof tokenSyncRequest.parse> | undefined;
      if (action === 'sync-token' && req.method === 'POST') {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 17_000) throw new Error('Invalid credential request'); chunks.push(Buffer.from(chunk)); }
        sync = tokenSyncRequest.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } else if (!preparing && req.headers['content-length'] && req.headers['content-length'] !== '0') return reply({ error: 'Unexpected body' }, 400);
      if (!(action === 'status' && req.method === 'GET') && !(['prepare', 'connect', 'cancel', 'disconnect', 'start', 'sync-token'].includes(action ?? '') && req.method === 'POST')) return reply({ error: 'Unknown action' }, 404);
      const prior = queue.get(owner) ?? Promise.resolve();
      const operation = async () => {
        if (action === 'prepare' && consent) {
          if (!dockerDriver || !enrollment) throw new Error('Consent enrollment is unsupported.');
          const readiness = await enrollmentReadiness(dockerDriver, owner);
          if (readiness.state !== 'ready') return readiness;
          // Preparation is infrastructure-only: an existing trusted connection is idempotent.
          if (dockerDriver.admitted(owner) && tokenBindings.has(owner) && readiness.runtimeState === 'running') return readiness;
          invalidateTokenBinding(owner);
          await enrollment.record(owner, consent);
          dockerDriver.admit(owner);
          // The owner can enter the computer fence only after temporary admission.
          // Hold that fence through runtime preparation and durable admission.
          let entered = false;
          try {
            return await computer.agentOperation(owner, async () => {
              entered = true;
              try { await driver.ensure(owner); await driver.clearToken(owner); }
              catch {
                await enrollment.rollback(owner);
                throw new Error('Runtime preparation unconfirmed');
              }
              try { await enrollment.record(owner, consent, 'admitted'); }
              catch { dockerDriver.revokeAdmission(owner); throw new Error('Enrollment persistence unconfirmed'); }
              return { ...readiness, enrolled: true, runtimeState: 'running' };
            });
          } catch (error) {
            if (!entered) await enrollment.rollback(owner);
            throw error;
          }
        }
        const currentAccess = await ownerAccess(owner);
        if (!currentAccess.known || !currentAccess.admitted && action !== 'status' && action !== 'disconnect')
          throw new Error('Owner admission changed.');
        if (action === 'disconnect') {
          // Fence readiness before any I/O: failed token clearing must never leave a trusted fingerprint.
          invalidateTokenBinding(owner);
          const current = await driver.inspect(owner);
          if (!currentAccess.admitted) {
            sessions.get(owner)?.client.close(); sessions.delete(owner);
            for (const bridge of ownerBridges.get(owner) ?? []) bridge.terminate();
            if (current?.State.Running) {
              if (!driver.stop) throw new Error('Runtime stop is unavailable.');
              await driver.stop(owner);
            }
            await clearMarker(owner);
            return status(owner);
          }
          if (!current || (!current.State.Running && driver.config.siwcSandboxVerified)) { await clearMarker(owner); return status(owner); }
          // Clear retained SIWC tokens even if admission was disabled since the last synchronization.
          // SIWC has no native account identity; clearing must never depend on account/logout.
          try {
            await driver.startRetained(owner);
            await driver.clearToken(owner);
          } finally {
            sessions.get(owner)?.client.close(); sessions.delete(owner);
          }
          if (driver.config.siwcSandboxVerified) { await clearMarker(owner); return status(owner); }
        }
        if (action === 'connect') {
          const current = await driver.inspect(owner);
          if (!current || !current.State.Running) invalidateTokenBinding(owner);
          await driver.ensure(owner);
        }
        if (action === 'start') {
          const current = await driver.inspect(owner);
          if (!current || !current.State.Running) invalidateTokenBinding(owner);
          await driver.startRetained(owner);
        }
        if (action === 'sync-token' && sync) {
          if (sync.credentialBinding !== tokenFingerprint(sync.accessToken)) throw new Error('Credential binding is invalid.');
          invalidateTokenBinding(owner);
          await driver.ensure(owner);
          await driver.synchronizeToken(owner, sync.accessToken, sync.credentialBinding);
          tokenBindings.set(owner, sync.credentialBinding);
          return { state: 'running', credential: 'synchronized' as const, siwc: await siwcStatus(owner) };
        }
        if (action === 'connect') {
          const session = await accountClient(owner);
          if (!session.login) {
            const current = nativeAccount.parse(await session.client.request('account/read', { refreshToken: false }));
            if (current.account) throw new Error('Disconnect before reconnecting');
            if (await hasMarker(owner)) throw new Error('Previous login dispatch is uncertain. Cancel before retrying.');
            // Non-secret durable uncertainty fence precedes native login. Lost replies are not replayed.
            await writeFile(loginMarker(owner), 'pending native device sign-in\n', { mode: 0o600, flag: 'wx' });
            session.login = pendingLogin.parse(await session.client.request('account/login/start', { type: 'chatgptDeviceCode' }, 15000));
            session.until = Date.now() + 15 * 60 * 1000;
            if (session.completed.has(session.login.loginId)) { session.login = undefined; await clearMarker(owner); }
          }
        } else if (action === 'cancel' || action === 'disconnect') {
          const session = await accountClient(owner, false);
          if (session.login) { await session.client.request('account/login/cancel', { loginId: session.login.loginId }); session.login = undefined; }
          // Explicit cancel/disconnect revokes any grant completed concurrently with cancellation.
          // Completion may already have removed both the in-memory login and durable marker.
          await session.client.request('account/logout', {});
          await clearMarker(owner);
        }
        return status(owner);
      };
      const next = prior.catch(() => {}).then(async () => {
        // Invalidate before waiting for an asynchronous computer bridge or account
        // operation. A pending upgrade must not inherit the earlier token generation.
        if (action === 'disconnect' || action === 'sync-token') invalidateTokenBinding(owner);
        // Preparation performs read-only preflight before admitting an owner to
        // the computer fence, then holds the fence around all runtime mutations.
        if (action === 'prepare') return operation();
        // SIWC status reads only host metadata and must remain available during human takeover.
        if (action === 'status' && driver.config.siwcSandboxVerified) return status(owner);
        return computer.agentOperation(owner, operation, { revokePaused: action === 'disconnect' });
      });
      queue.set(owner, next);
      try { reply(await next); } finally { if (queue.get(owner) === next) queue.delete(owner); }
    })().catch(error => {
      if (req.url?.startsWith('/admin/')) return reply(error instanceof SandboxAdminError
        ? { code: error.code, error: error.message }
        : { code: 'operation_failed', error: 'The sandbox operation could not be confirmed. Refresh its status before retrying.' },
      error instanceof SandboxAdminError ? error.status : 503);
      return reply({ error: isTokenSync && !driver.config.siwcSandboxVerified
      ? 'Personal Codex token sharing is unavailable until an operator verifies the stock sandbox shell environment and /proc isolation proof.'
      : 'Personal Codex operation failed. Reload before retrying. Runtime data is retained.' }, 503);
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    let bridge: ChildProcessWithoutNullStreams | undefined;
    void (async () => {
      if (req.url !== '/runtime') throw new Error();
      const owner = ownerId.parse(req.headers['x-collective-owner']);
      const authority = await authorizeBridge(owner);
      const child = await computer.agentBridge(owner);
      bridge = child;
      child.on('error', () => socket.destroy());
      await authorizeBridge(owner, authority);
      // The async proof check above may yield. Recheck the cached authority and
      // owner admission immediately before granting the WebSocket transport.
      bridgeAuthorityNow(owner, authority.siwc, authority);
      wss.handleUpgrade(req, socket, head, ws => {
        const bridges = ownerBridges.get(owner) ?? new Set<WebSocket>();
        bridges.add(ws); ownerBridges.set(owner, bridges);
        child.stderr.resume();
        const lines = createInterface({ input: child.stdout });
        let bytes = 0;
        // readline's unbounded internal buffer is also bounded before parsing.
        child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) child.kill(); if (chunk.includes(10)) bytes = 0; });
        lines.on('line', line => { if (line.length > 1024 * 1024 || ws.bufferedAmount > 2 * 1024 * 1024) ws.terminate(); else ws.send(line); });
        ws.on('message', data => { if (!child.stdin.write(`${data}\n`)) ws.pause(); });
        child.stdin.on('drain', () => ws.resume());
        child.stdin.on('error', () => ws.terminate()); child.on('error', () => ws.terminate()); child.on('exit', () => ws.terminate());
        ws.on('close', () => {
          bridges.delete(ws); if (!bridges.size) ownerBridges.delete(owner);
          lines.close(); child.stdin.end(); child.kill();
        }); ws.on('error', () => child.kill());
      });
    })().catch(() => {
      bridge?.stdin.end(); bridge?.kill();
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy();
    });
  });
  // Restore persisted human-control fences before any broker request can reach the runtime.
  // The controller reads each owner's record first and does no runtime work when none exists.
  await admin?.initialize();
  await computer.reconcilePersistedPauses(driver instanceof SbxPersonalCodexDriver && driver.config.adminEnabled
    ? await driver.adminKnownOwners() : driver.admittedOwners?.() ?? driver.config.owners);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o660);
  return { server, close: async () => { for (const session of sessions.values()) session.client.close(); for (const ws of wss.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
