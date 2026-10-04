import { eq } from 'drizzle-orm';
import { db, type DbOrTx } from '@/db';
import { aiApps, bots, users } from '@/db/schema';
import { loadPrincipal, type Principal } from '@/lib/auth/groups';
import { HttpError, getUsableBot } from '@/lib/authz';
import { getSetting } from '@/lib/settings';
import { LOCAL_ORIGIN } from '@/lib/local-hermes/client';
import { initializeBotPet } from '@/lib/pets/store';
import { bindingSchema, type DockerBinding, type DockerStatus, type NativeResources } from '@/docker-hermes/types';
import { assertDockerAllowed, assertDockerCreate, isDockerHermes } from './policy';
import { dockerControl } from './client';
import { lockDockerOwner } from './enrollment';
export async function freshDocker(p: Principal, create = false, q: DbOrTx = db) {
  const fresh = await loadPrincipal(p.user.id, q);
  if (!fresh || fresh.user.sessionVersion !== p.user.sessionVersion) throw new HttpError(403, 'Your access changed. Sign in again.');
  if (create) await assertDockerCreate(fresh, await getSetting('tools', q), q); else await assertDockerAllowed(fresh, q);
  return fresh;
}
export async function pairDockerBot(p: Principal, raw: DockerBinding, lockWaitMs?: number) {
  const b = bindingSchema.parse(raw);
  if (b.ownerId !== p.user.id) throw new HttpError(403, 'Runtime owner mismatch.');
  return db.transaction(async tx => {
    await lockDockerOwner(tx, p.user.id, lockWaitMs);
    // Serialize account revocation with final app publication.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, p.user.id)).for('share');
    const fresh = await freshDocker(p, true, tx);
    const [app] = await tx.select().from(aiApps).where(eq(aiApps.id, b.appId));
    const [bot] = await tx.select().from(bots).where(eq(bots.id, b.botId));
    if (app || bot) {
      if (!app || !bot || !isDockerHermes(app) || JSON.stringify(bindingSchema.parse(app.providerConfig.docker)) !== JSON.stringify(b) ||
        bot.ownerId !== p.user.id || bot.appId !== app.id || bot.visibility !== 'private' || bot.executionMode !== 'caller' || bot.coordinatorEligible)
        throw new HttpError(409, 'Retained native mapping needs operator reconciliation. No bot was reassigned.');
      return bot.id;
    }
    await tx.insert(aiApps).values({ id: b.appId, name: `${b.name} · Personal Hermes`, provider: 'hermes', model: 'native-profile', baseUrl: LOCAL_ORIGIN,
      providerConfig: { profile: '', allowedModels: '', approvalTimeoutSec: 300, docker: b }, supportsTools: true, isPublic: false });
    const [created] = await tx.insert(bots).values({ id: b.botId, ownerId: p.user.id, appId: b.appId, name: b.name,
      description: 'Personal Hermes · native skills, memory and sessions', visibility: 'private', avatar: '🪽' }).returning();
    await initializeBotPet(tx, fresh, created, { appearance: 'moss', catalogId: null });
    return b.botId;
  });
}
export async function dockerStatus(p: Principal) {
  await freshDocker(p);
  return dockerControl<DockerStatus>(p.user.id, '/control/status');
}
export async function nativeResources(p: Principal, botId: string): Promise<NativeResources> {
  await freshDocker(p);
  const bot = await getUsableBot(p, botId);
  const [app] = bot.appId ? await db.select().from(aiApps).where(eq(aiApps.id, bot.appId)) : [];
  if (!app?.enabled || !isDockerHermes(app)) throw new HttpError(400, 'This bot has no personal native profile.');
  const b = bindingSchema.parse(app.providerConfig.docker);
  if (b.botId !== bot.id || b.ownerId !== p.user.id || b.ownerId !== bot.ownerId) throw new HttpError(403, 'Native profile owner mismatch.');
  return dockerControl(p.user.id, `/resources/${b.bindingId}`);
}

/** Rechecked before each batch of a native chat stream, including restored browser streams. */
export async function authorizeDockerStream(p: Principal, botId: string) {
  const fresh = await freshDocker(p);
  const bot = await getUsableBot(fresh, botId);
  const [app] = bot.appId ? await db.select().from(aiApps).where(eq(aiApps.id, bot.appId)) : [];
  if (!app?.enabled || !isDockerHermes(app)) throw new HttpError(403, 'Native bot access changed.');
}

/** Historical/synthetic share tokens cannot turn private native transcripts into shared snapshots. */
export async function isPersonalHermesConversation(conv: { botId: string | null; appId: string | null }) {
  if (conv.botId) {
    const [row] = await db.select({ app: aiApps }).from(bots).innerJoin(aiApps, eq(aiApps.id, bots.appId)).where(eq(bots.id, conv.botId));
    if (row && isDockerHermes(row.app)) return true;
  }
  const [app] = conv.appId ? await db.select().from(aiApps).where(eq(aiApps.id, conv.appId)) : [];
  return !!app && isDockerHermes(app);
}

/** Serialize setup/lease dispatch with revocation. A queued stale action must recheck after taking the lock. */
export async function withDockerAccess<T>(p: Principal, create: boolean, fn: (fresh: Principal) => Promise<T>) {
  return db.transaction(async tx => {
    await lockDockerOwner(tx, p.user.id);
    const fresh = await freshDocker(p, create, tx);
    return fn(fresh);
  });
}
