import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { remoteHermesConnections, settings } from '@/db/schema';
import { HttpError } from '@/lib/authz';
import { decrypt, encrypt } from '@/lib/crypto';
import { newId } from '@/lib/ids';
import { getSetting } from '@/lib/settings';
import { DashboardClient, dashboardSecretsSchema, type DashboardSecrets } from './client';
import { assertRemoteHermesAdmission, dashboardBase } from './policy';
import { dashboardFetch } from './transport';
import { retireNativeConnection } from './lifecycle';

export const remoteConnectionInput = z.object({
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().max(2048).transform(dashboardBase),
  mode: z.enum(['password', 'sessionToken']),
  username: z.string().trim().max(200).optional(), password: z.string().max(4096).optional(), sessionToken: z.string().max(4096).optional(),
}).superRefine((v, ctx) => {
  if (v.mode === 'password' ? !v.username || !v.password : !v.sessionToken)
    ctx.addIssue({ code: 'custom', message: 'Enter the credentials for the chosen sign-in method.' });
});
export type RemoteConnectionInput = z.input<typeof remoteConnectionInput>;
const aad = (id: string, owner: string) => `remote_hermes_connections.secret_enc|${id}|${owner}`;
const publicColumns = { id: remoteHermesConnections.id, name: remoteHermesConnections.name, baseUrl: remoteHermesConnections.baseUrl, authMode: remoteHermesConnections.authMode, version: remoteHermesConnections.version };
export type RemoteConnectionView = { id: string; name: string; baseUrl: string; authMode: 'password' | 'sessionToken'; version: string | null };

export async function listRemoteConnections(userId: string): Promise<RemoteConnectionView[]> {
  return db.select(publicColumns).from(remoteHermesConnections).where(eq(remoteHermesConnections.userId, userId)).orderBy(asc(remoteHermesConnections.name));
}

export async function connectRemoteHermes(userId: string, raw: RemoteConnectionInput) {
  const policy = await getSetting('remoteHermes');
  assertRemoteHermesAdmission(policy);
  const input = remoteConnectionInput.parse(raw);
  const transport = dashboardFetch(input.baseUrl, policy);
  const client = new DashboardClient(input.baseUrl, transport);
  const status = await client.status();
  if (input.mode === 'sessionToken' && status.authRequired === true) throw new HttpError(400, 'This Hermes dashboard requires sign-in. Use username and password.');
  const secrets: DashboardSecrets = input.mode === 'password'
    ? await client.passwordLogin(input.username!, input.password!)
    : dashboardSecretsSchema.parse({ mode: 'sessionToken', sessionToken: input.sessionToken });
  // Verify the credential on an authenticated endpoint before retaining it.
  const profiles = await new DashboardClient(input.baseUrl, transport, secrets).profiles();
  let retiredId: string | undefined;
  const connection = await db.transaction(async tx => {
    // Share lock serializes final admission against an administrator disabling connections.
    await tx.select().from(settings).where(eq(settings.key, 'remoteHermes')).for('share');
    assertRemoteHermesAdmission(await getSetting('remoteHermes', tx));
    const [existing] = await tx.select().from(remoteHermesConnections).where(and(eq(remoteHermesConnections.userId, userId), eq(remoteHermesConnections.baseUrl, input.baseUrl))).for('update');
    // A sign-in is a new authorization identity, even when profile names overlap.
    // Retire local session bindings/receipts through the FK cascade rather than
    // letting the replacement account inherit server-owned native IDs.
    const id = newId();
    if (existing) {
      retiredId = existing.id;
      await tx.delete(remoteHermesConnections).where(eq(remoteHermesConnections.id, existing.id));
    }
    const values = { name: input.name, authMode: input.mode, version: status.version ?? null, secretEnc: encrypt(JSON.stringify(secrets), aad(id, userId)), updatedAt: new Date() };
    return (await tx.insert(remoteHermesConnections).values({ ...values, id, userId, baseUrl: input.baseUrl }).returning(publicColumns))[0];
  });
  if (retiredId) retireNativeConnection(userId, retiredId);
  return { connection, profiles };
}

export async function remoteProfiles(userId: string, connectionId: string) {
  const policy = await getSetting('remoteHermes');
  assertRemoteHermesAdmission(policy);
  const client = await db.transaction(async tx => {
    // Serialize token refresh: native refresh tokens may rotate on each use.
    const [row] = await tx.select().from(remoteHermesConnections).where(and(eq(remoteHermesConnections.userId, userId), eq(remoteHermesConnections.id, connectionId))).for('update');
    if (!row) throw new HttpError(404, 'Hermes connection not found.');
    const transport = dashboardFetch(row.baseUrl, policy);
    let secrets = dashboardSecretsSchema.parse(JSON.parse(decrypt(row.secretEnc, aad(row.id, userId))));
    let client = new DashboardClient(row.baseUrl, transport, secrets);
    if (secrets.mode === 'password' && secrets.expiresAt !== undefined && secrets.expiresAt * 1000 < Date.now() + 60_000) {
      secrets = await client.refresh();
      await tx.update(remoteHermesConnections).set({ secretEnc: encrypt(JSON.stringify(secrets), aad(row.id, userId)), updatedAt: new Date() }).where(eq(remoteHermesConnections.id, row.id));
      client = new DashboardClient(row.baseUrl, transport, secrets);
    }
    return client;
  });
  // Commit rotated tokens before another native request can fail: refresh is an external side effect.
  return client.profiles();
}

/** Continuation callers must first authorize a server-loaded active session binding. */
export async function remoteAccess(userId: string, connectionId: string, mode: 'admission' | 'continuation') {
  const policy = await getSetting('remoteHermes');
  if (mode === 'admission') assertRemoteHermesAdmission(policy);
  const target = await db.transaction(async tx => {
    const [row] = await tx.select().from(remoteHermesConnections).where(and(eq(remoteHermesConnections.userId, userId), eq(remoteHermesConnections.id, connectionId))).for('update');
    if (!row) throw new HttpError(404, 'Hermes connection not found.');
    const transport = dashboardFetch(row.baseUrl, policy);
    let secrets = dashboardSecretsSchema.parse(JSON.parse(decrypt(row.secretEnc, aad(row.id, userId))));
    if (secrets.mode === 'password' && secrets.expiresAt !== undefined && secrets.expiresAt * 1000 < Date.now() + 60_000) {
      secrets = await new DashboardClient(row.baseUrl, transport, secrets).refresh();
      await tx.update(remoteHermesConnections).set({ secretEnc: encrypt(JSON.stringify(secrets), aad(row.id, userId)), updatedAt: new Date() }).where(eq(remoteHermesConnections.id, row.id));
    }
    return { baseUrl: row.baseUrl, secrets };
  });
  return { ...target, policy, client: new DashboardClient(target.baseUrl, dashboardFetch(target.baseUrl, policy), target.secrets) };
}
