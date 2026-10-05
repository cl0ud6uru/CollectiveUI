import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { remoteHermesSessions, remoteHermesTurns, settings } from '@/db/schema';
import { HttpError } from '@/lib/authz';
import { newId } from '@/lib/ids';
import { hmacSha256Hex, toolApprovalSecret } from '@/lib/crypto';
import { getSetting } from '@/lib/settings';
import { nativeHub } from './hub';
import { assertRemoteHermesAdmission } from './policy';
import { remoteAccess } from './store';
import { ownedNativeSession } from './sessions';
import { administrationInput, mcpInventory, probeSummary, settingValue, settingValues } from './administration-contract';

export async function nativeAdministration(ownerId: string, connectionId: string, sessionId: string, raw: unknown) {
  const input = administrationInput.parse(raw);
  // Bind both connection ownership and profile to the persisted session, never to browser input.
  const row = await ownedNativeSession(ownerId, connectionId, sessionId);
  const access = await remoteAccess(ownerId, connectionId, 'admission');
  if (!(await access.client.profiles()).some(p => p.name === row.profile)) throw new HttpError(404, 'Hermes profile not found.');
  const hub = nativeHub(ownerId, connectionId);
  const snapshot = await hub.refresh(row);
  const runtimeId = hub.sessions.get(row.id)?.row.runtimeId;
  if (!runtimeId) throw new HttpError(409, 'Open this Hermes conversation before changing settings.');
  const params = { profile: row.profile, session_id: runtimeId };
  return db.transaction(async tx => {
    // Keep the admin switch locked through dispatch, so disabling cannot race new administration work.
    await tx.select().from(settings).where(eq(settings.key, 'remoteHermes')).for('share');
    assertRemoteHermesAdmission(await getSetting('remoteHermes', tx));
    if (input.operation === 'inspect') {
      const read = async (key: 'reasoning' | 'fast', session: boolean) => {
        try { return { supported: true, value: settingValue(key, await hub.socket.call('config.get', { profile: row.profile, ...(session ? { session_id: runtimeId } : {}), key })) }; }
        catch (error) { if (error instanceof HttpError && error.status === 501) return { supported: false, value: '' }; throw error; }
      };
      const session = { reasoning: await read('reasoning', true), fast: await read('fast', true) };
      const profile = { reasoning: await read('reasoning', false), fast: await read('fast', false) };
      let mcp: ReturnType<typeof mcpInventory> | null = null;
      try {
        const list = await hub.socket.call('mcp.servers.list', { profile: row.profile });
        const status = await hub.socket.call('mcp.servers.status', { profile: row.profile });
        const catalog = await hub.socket.call('mcp.catalog', { profile: row.profile });
        mcp = mcpInventory(list, status, catalog);
      } catch (error) { if (!(error instanceof HttpError) || error.status !== 501) throw error; }
      return { session, profile, mcp, profileName: row.profile };
    }
    const [current] = await tx.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, row.id)).for('update');
    if (!current || current.status !== 'idle' || snapshot.running) throw new HttpError(409, 'Finish this native turn before administering Hermes.');
    if (input.operation === 'test') {
      const inventory = mcpInventory(await hub.socket.call('mcp.servers.list', { profile: row.profile }), {}, {});
      if (!inventory.servers.some(s => s.name === input.name)) throw new HttpError(404, 'MCP server not found in this profile.');
      return probeSummary(await hub.socket.call('mcp.servers.test', { profile: row.profile, name: input.name }, 60_000));
    }
    // A keyed, domain-separated digest prevents offline guessing of protected credential inputs.
    const digest = hmacSha256Hex(toolApprovalSecret('native-administration-receipt:v1'), JSON.stringify(input));
    const [receipt] = await tx.select().from(remoteHermesTurns).where(and(eq(remoteHermesTurns.sessionId, row.id), eq(remoteHermesTurns.requestId, input.requestId)));
    if (receipt) { if (receipt.digest !== digest) throw new HttpError(409, 'This operation receipt belongs to different content.'); return { accepted: true, duplicate: true }; }
    if (input.operation === 'setting' && !(settingValues[input.key] as readonly string[]).includes(input.value)) throw new HttpError(400, 'Choose a supported setting value.');
    if (input.operation === 'install') {
      const inventory = mcpInventory({}, {}, await hub.socket.call('mcp.catalog', { profile: row.profile }));
      if (!inventory.catalog.some(s => s.name === input.preset && !s.installed)) throw new HttpError(409, 'Choose an uninstalled preset from this profile’s catalog.');
    }
    if (input.operation === 'credential') {
      const inventory = mcpInventory(await hub.socket.call('mcp.servers.list', { profile: row.profile }), {}, {});
      if (!inventory.servers.some(s => s.name === input.name && s.source === 'config' && s.envKeys.includes(input.envVar))) throw new HttpError(400, 'Choose an existing credential key for a configured MCP server.');
    }
    await tx.insert(remoteHermesTurns).values({ id: newId(), sessionId: row.id, requestId: input.requestId, digest });
    // Commit before dispatch: a lost response never silently repeats an administration operation.
    return { dispatch: async () => {
      if (input.operation === 'setting') {
        const result = await hub.socket.call('config.set', { profile: row.profile, ...(input.scope === 'session' ? { session_id: params.session_id, scope: 'session' } : { scope: 'global' }), key: input.key, value: input.value });
        return { accepted: true, value: settingValue(input.key, result) };
      }
      if (input.operation === 'install') {
        const result = await hub.socket.call('mcp.servers.add', { profile: row.profile, name: input.preset, preset: input.preset });
        return { accepted: result.ok === true };
      }
      const result = await hub.socket.call('mcp.servers.set_api_key', { profile: row.profile, name: input.name, env_var: input.envVar, value: input.value });
      return { accepted: result.ok === true };
    } };
  }).then(async result => {
    if ('dispatch' in result && typeof result.dispatch === 'function') {
      const dispatch = result.dispatch;
      // Receipt is durable, but admission and session state are checked again before sending.
      return db.transaction(async tx => {
        await tx.select().from(settings).where(eq(settings.key, 'remoteHermes')).for('share');
        assertRemoteHermesAdmission(await getSetting('remoteHermes', tx));
        const [current] = await tx.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, row.id)).for('update');
        if (!current || current.status !== 'idle' || hub.sessions.get(row.id)?.view.running) throw new HttpError(409, 'Finish this native turn before administering Hermes.');
        return dispatch();
      });
    }
    return result;
  });
}
