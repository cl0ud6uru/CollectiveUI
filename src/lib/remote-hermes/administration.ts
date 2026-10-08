import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { remoteHermesSessions, remoteHermesTurns } from '@/db/schema';
import { HttpError } from '@/lib/authz';
import { newId } from '@/lib/ids';
import { hmacSha256Hex, toolApprovalSecret } from '@/lib/crypto';
import { getSetting } from '@/lib/settings';
import { nativeHub } from './hub';
import { assertRemoteHermesAdmission } from './policy';
import { remoteAccess } from './store';
import { ownedNativeSession } from './sessions';
import { administrationInput, mcpInventory, probeSummary, settingValue, settingValues } from './administration-contract';

function assertIdle(current: { status: string; queueRequestId?: string | null } | undefined,
  view: { running: boolean; uncertain?: boolean; queuePending?: boolean } | undefined) {
  if (!current || current.status !== 'idle' || current.queueRequestId || !view || view.running || view.uncertain || view.queuePending)
    throw new HttpError(409, 'Finish this native turn before administering Hermes.');
}

export async function nativeAdministration(ownerId: string, connectionId: string, sessionId: string, raw: unknown) {
  const input = administrationInput.parse(raw);
  // Bind ownership and profile to the persisted session, never browser input.
  const row = await ownedNativeSession(ownerId, connectionId, sessionId);
  const access = await remoteAccess(ownerId, connectionId, 'admission');
  if (!(await access.client.profiles()).some(p => p.name === row.profile)) throw new HttpError(404, 'Hermes profile not found.');
  const hub = nativeHub(ownerId, connectionId);
  await hub.refresh(row);
  const runtimeId = hub.sessions.get(row.id)?.row.runtimeId;
  if (!runtimeId) throw new HttpError(409, 'Open this Hermes conversation before changing settings.');
  const epoch = hub.socket.connectionEpoch;
  const params = { profile: row.profile, session_id: runtimeId };
  // Inspection and catalog reads have their own dispatch fences. Never hold a
  // caller's session lock while waiting on remote inventory/acknowledgements.
  if (input.operation === 'inspect') {
    const read = async (key: 'reasoning' | 'fast', session: boolean) => {
      try {
        // The pinned runtime's fast getter loses auto/cold; status returns the
        // actual tier, including lazy session pins, without a tier change.
        const result = key === 'fast'
          ? await hub.socket.call('config.set', { profile: row.profile, ...(session ? { session_id: runtimeId, scope: 'session' } : { scope: 'global' }), key, value: 'status' })
          : await hub.socket.call('config.get', { profile: row.profile, ...(session ? { session_id: runtimeId } : {}), key });
        return { supported: true, value: settingValue(key, result) };
      } catch (error) { if (error instanceof HttpError && error.status === 501) return { supported: false, value: '' }; throw error; }
    };
    const session = { reasoning: await read('reasoning', true), fast: await read('fast', true) };
    const profile = { reasoning: await read('reasoning', false), fast: await read('fast', false) };
    let mcp: ReturnType<typeof mcpInventory> | null = null;
    try {
      mcp = mcpInventory(await hub.socket.call('mcp.servers.list', { profile: row.profile }),
        await hub.socket.call('mcp.servers.status', { profile: row.profile }), await hub.socket.call('mcp.catalog', { profile: row.profile }));
    } catch (error) { if (!(error instanceof HttpError) || error.status !== 501) throw error; }
    return { session, profile, mcp, profileName: row.profile };
  }
  // Fast preflight avoids even inventory work for an already busy conversation;
  // the durable state is checked again under locks before reservation and send.
  assertIdle({ ...row, ...hub.sessions.get(row.id)?.row }, hub.sessions.get(row.id)?.view);
  if (input.operation === 'test' || input.operation === 'credential') {
    const inventory = mcpInventory(await hub.socket.call('mcp.servers.list', { profile: row.profile }), {}, {});
    if (input.operation === 'test' && !inventory.servers.some(s => s.name === input.name)) throw new HttpError(404, 'MCP server not found in this profile.');
    if (input.operation === 'credential' && !inventory.servers.some(s => s.name === input.name && s.source === 'config' && s.envKeys.includes(input.envVar)))
      throw new HttpError(400, 'Choose an existing credential key for a configured MCP server.');
  }
  if (input.operation === 'install') {
    const inventory = mcpInventory({}, {}, await hub.socket.call('mcp.catalog', { profile: row.profile }));
    if (!inventory.catalog.some(s => s.name === input.preset && !s.installed)) throw new HttpError(409, 'Choose an uninstalled preset from this profile’s catalog.');
  }
  if (input.operation === 'setting' && !(settingValues[input.key] as readonly string[]).includes(input.value)) throw new HttpError(400, 'Choose a supported setting value.');
  const lock = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
    await hub.lockBoundary(tx);
    assertRemoteHermesAdmission(await getSetting('remoteHermes', tx));
    const [current] = await tx.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, row.id)).for('update');
    assertIdle(current, hub.sessions.get(row.id)?.view);
  };
  if (input.operation === 'test') {
    const { reply } = await db.transaction(async tx => {
      await lock(tx);
      return hub.socket.dispatchConnected('mcp.servers.test', { profile: row.profile, name: input.name }, epoch, 60_000, tx);
    });
    return probeSummary(await reply);
  }
  // A keyed digest prevents offline guessing of protected credential inputs.
  const digest = hmacSha256Hex(toolApprovalSecret('native-administration-receipt:v1'), JSON.stringify(input));
  const reserved = await db.transaction(async tx => {
    await lock(tx);
    const [receipt] = await tx.select().from(remoteHermesTurns).where(and(eq(remoteHermesTurns.sessionId, row.id), eq(remoteHermesTurns.requestId, input.requestId)));
    if (receipt) { if (receipt.digest !== digest) throw new HttpError(409, 'This operation receipt belongs to different content.'); return false; }
    await tx.insert(remoteHermesTurns).values({ id: newId(), sessionId: row.id, requestId: input.requestId, digest });
    return true;
  });
  if (!reserved) return { accepted: true, duplicate: true };
  // The receipt is committed before dispatch. Locks cover the synchronous send,
  // not its acknowledgement; reuse tx to avoid nested-pool/session deadlocks.
  const { reply } = await db.transaction(async tx => {
    await lock(tx);
    if (input.operation === 'setting') return hub.socket.dispatchConnected('config.set', { profile: row.profile, ...(input.scope === 'session' ? { session_id: params.session_id, scope: 'session' } : { scope: 'global' }), key: input.key, value: input.value }, epoch, 30_000, tx);
    if (input.operation === 'install') return hub.socket.dispatchConnected('mcp.servers.add', { profile: row.profile, name: input.preset, preset: input.preset }, epoch, 30_000, tx);
    return hub.socket.dispatchConnected('mcp.servers.set_api_key', { profile: row.profile, name: input.name, env_var: input.envVar, value: input.value }, epoch, 30_000, tx);
  });
  const result = await reply;
  return input.operation === 'setting' ? { accepted: true, value: settingValue(input.key, result) } : { accepted: result.ok === true };
}
