import { createHash, randomUUID } from 'node:crypto';
import { and, eq, like } from 'drizzle-orm';
import { db, type DbOrTx } from '@/db';
import { personalCodexAccounts, userCredentials } from '@/db/schema';
import { loadPrincipal, resolvePrincipal, type Principal } from '@/lib/auth/groups';
import { HttpError } from '@/lib/authz';
import { getSetting } from '@/lib/settings';
import { assertNoCodexWork, connectionView, lockPersonalOwner } from '@/personal-codex/accounts';
import { personalControl } from '@/personal-codex/control';
import { accountRejection, userMayUseChatGPT } from './policy';
import { getChatGPTAuth, getChatGPTCredential, openCredentialSecret, revokeCredentialSecret, saveChatGPTConnection, type ChatGPTSecret } from './store';
import { invalidateChatGPTConnectionLocked, invalidateNativeChatGPTConnectionLocked } from './invalidation';
import { SIWCCredentialSchema, validateSIWCCredential, type SIWCCredential, type SIWCIdentity } from './siwc';
import { accountSetupView, deviceAccountSetupView, localSignInReason } from './onboarding';
import { companionSignInView } from './companion-state';

const hostId = () => process.env.CHATGPT_SIWC_HOST_ID?.trim();
const onboardingReason = localSignInReason;

/** Browser projection deliberately excludes tokens, refresh data and token fingerprints. */
export async function unifiedAccountView(p: Principal) {
  const [settings, row] = await Promise.all([getSetting('chatgpt'), getChatGPTCredential(p.user.id)]);
  const allowed = userMayUseChatGPT(p, settings);
  const reason = allowed ? null : !settings.enabled ? 'ChatGPT connections are disabled. An administrator can enable them in Admin → Settings → ChatGPT.' : 'Your account is not enrolled. Ask an administrator to allow your user or group in ChatGPT settings.';
  let migrationRequired = false, fingerprint: string | undefined;
  if (row) {
    try { const s = openCredentialSecret(row); migrationRequired = !s.siwc || s.siwc.hostId !== hostId(); fingerprint = createHash('sha256').update(s.access).digest('hex'); }
    catch { migrationRequired = true; }
  }
  const policyReason = settings.allowedWorkspaceIds.some(value => value.trim()) ? 'The legacy workspace allowlist cannot be verified by SIWC. An administrator must explicitly revise it.' : !settings.allowPersonalPlans ? 'An administrator must explicitly enable personal ChatGPT plans before using SIWC.' : null;
  const nativeState = !allowed ? 'disabled' : !row ? 'not_connected' : migrationRequired ? 'migration_required' : policyReason ? 'policy_blocked' : row.status !== 'active' ? 'needs_reauth' : row.expiresAt && row.expiresAt.getTime() <= Date.now() ? 'refresh_required' : 'connected';
  let codex: { state: string; reason?: string } = { state: 'unavailable', reason: 'Stock Codex is not installed. An operator must install the reviewed runtime and enroll this user; your account remains usable by the native harness.' };
  if (process.env.PERSONAL_CODEX_SOCKET) {
    try {
      const status = await personalControl(p.user.id, 'status');
      codex = status.siwc?.available ? { state: status.state === 'running' && status.siwc.credentialBinding === fingerprint && nativeState === 'connected' ? 'connected' : status.state === 'stopped' ? 'stopped' : 'not_connected', reason: status.state === 'running' && status.siwc.credentialBinding === fingerprint ? undefined : 'This runtime uses the separately configured SIWC connection.' } : { state: (await connectionView(p)).state };
    } catch (error) { codex = error instanceof HttpError && error.message.includes('not enrolled') ? { state: 'not_enrolled', reason: error.message } : { state: 'backend_error', reason: 'Stock Codex is unavailable. Ask the operator to check the broker, then retry.' }; }
  }
  if (!allowed) codex = { state: 'disabled', reason: reason! };
  const [setup, deviceSetup, signIn] = await Promise.all([accountSetupView(p, settings), deviceAccountSetupView(p, settings), companionSignInView(p)]);
  return { allowed, reason, setup, deviceSetup, signIn, credential: row ? { email: row.email, planType: row.planType, status: row.status, migrationRequired } : null,
    backends: { native: { state: nativeState, ...(reason || policyReason ? { reason: reason ?? policyReason! } : {}) }, codex },
    onboarding: { state: hostId() ? 'ready' as const : 'blocked' as const, reason: hostId() ? onboardingReason : 'An operator must finish this installation’s ChatGPT sign-in configuration.' } };
}

/** Shared commit after independent token validation. Caller keeps external I/O outside this transaction. */
export async function applySIWCProfileLocked(p: Principal, profile: SIWCCredential, identity: SIWCIdentity, tx: DbOrTx) {
  const installation = hostId();
  if (!installation) throw new HttpError(409, 'Configure this installation’s stable ChatGPT host ID first.');
  let previous: ChatGPTSecret | undefined;
  const person = await lockPersonalOwner(p.user.id, tx);
  if (person.disabled || person.sessionVersion !== p.user.sessionVersion) throw new HttpError(403, 'Sign in to CollectiveUI again.');
  const fresh = await resolvePrincipal(person, tx), settings = await getSetting('chatgpt', tx);
  if (!userMayUseChatGPT(fresh, settings)) throw new HttpError(403, 'Personal ChatGPT access is not enabled for you.');
  if (![person.email, person.upn].some(value => value?.toLowerCase() === identity.email.toLowerCase())) throw new HttpError(403, 'Import only your own ChatGPT profile matching your CollectiveUI email.');
  // SIWC hides workspace/plan metadata. Never reinterpret client_id as a legacy workspace ID.
  if (settings.allowedWorkspaceIds.some(value => value.trim())) throw new HttpError(403, 'The legacy workspace allowlist cannot be verified from SIWC’s opaque metadata. An administrator must explicitly revise that policy before importing.');
  if (!settings.allowPersonalPlans) throw new HttpError(403, 'Enable personal ChatGPT plans explicitly before importing a SIWC profile; plan metadata is not exposed by this integration.');
  await assertNoCodexWork(person.id, tx);
  const [old] = await tx.select().from(userCredentials).where(eq(userCredentials.userId, person.id)).for('update');
  if (old) { try { previous = openCredentialSecret(old); } catch { /* explicit unreadable migration */ } }
  const sameRegistration = old?.externalSubject === identity.subject && previous?.siwc?.clientId === identity.clientId;
  const row = await saveChatGPTConnection(person.id, { accessToken: profile.accessToken, refreshToken: profile.refreshToken, idToken: profile.idToken, expiresIn: profile.expiresIn },
    { accountId: `siwc:${identity.clientId}`, userId: identity.subject, email: identity.email.toLowerCase(), planType: null, residency: null, isFedramp: false, expiresAt: identity.expiresAt },
    undefined, { clientId: identity.clientId, hostId: installation, scope: profile.scope }, tx, false);
  // Reconnect invalidates old native bindings without touching retained workspace data.
  await tx.update(personalCodexAccounts).set({ connected: false, ...(!sameRegistration ? { credentialBinding: randomUUID() } : {}), updatedAt: new Date() })
    .where(and(eq(personalCodexAccounts.userId, person.id), like(personalCodexAccounts.workspaceId, 'siwc:%')));
  return { saved: { email: row.email, status: row.status }, previous };

}

/** Explicit import is server/CLI-only. A browser cannot post credentials to this service. */
export async function importSIWCProfile(p: Principal, raw: unknown) {
  const profile = SIWCCredentialSchema.parse(raw);
  const identity = await validateSIWCCredential(profile, { hostId: profile.hostId });
  const { saved, previous } = await db.transaction(tx => applySIWCProfileLocked(p, profile, identity, tx));
  if (previous && previous.refresh !== profile.refreshToken) await revokeCredentialSecret(previous);
  return saved;
}

export async function changeUnifiedAccount(p: Principal, action: 'start' | 'disconnect' | 'disconnect-native' | 'sync-token') {
  if (action === 'disconnect' || action === 'disconnect-native') {
    let revoke: (() => Promise<boolean>) | null = null;
    await db.transaction(async tx => {
      const person = await lockPersonalOwner(p.user.id, tx);
      if (person.disabled || person.sessionVersion !== p.user.sessionVersion) throw new HttpError(403, 'Sign in to CollectiveUI again.');
      revoke = action === 'disconnect-native' ? await invalidateNativeChatGPTConnectionLocked(person.id, tx) : await invalidateChatGPTConnectionLocked(person.id, tx);
    });
    const revocationConfirmed = revoke ? await (revoke as () => Promise<boolean>)() : true;
    return { disconnected: true, revocationConfirmed };
  }
  // Refresh owns a separate credential transaction. Finish it before taking the owner lock, then
  // recheck the exact credential under that lock before transmitting anything to the runtime.
  let preparedAuth: Awaited<ReturnType<typeof getChatGPTAuth>> | undefined;
  if (action === 'sync-token') {
    const fresh = await loadPrincipal(p.user.id);
    if (!fresh || fresh.user.disabled || fresh.user.sessionVersion !== p.user.sessionVersion) throw new HttpError(403, 'Sign in to CollectiveUI again.');
    const settings = await getSetting('chatgpt');
    if (!userMayUseChatGPT(fresh, settings)) throw new HttpError(403, 'Personal ChatGPT access is not enabled for you.');
    preparedAuth = await getChatGPTAuth(p.user.id);
  }
  return db.transaction(async tx => {
    const person = await lockPersonalOwner(p.user.id, tx);
    if (person.disabled || person.sessionVersion !== p.user.sessionVersion) throw new HttpError(403, 'Sign in to CollectiveUI again.');
    const settings = await getSetting('chatgpt', tx);
    if (!userMayUseChatGPT(await resolvePrincipal(person, tx), settings)) throw new HttpError(403, 'Personal ChatGPT access is not enabled for you.');
    if (action === 'start') {
      const installation = hostId();
      if (!installation) throw new HttpError(409, 'Configure CHATGPT_SIWC_HOST_ID first.');
      return { instructions: onboardingReason, hostId: installation, userId: person.id };
    }
    await assertNoCodexWork(person.id, tx);
    const auth = preparedAuth!;
    const [row] = await tx.select().from(userCredentials).where(eq(userCredentials.userId, person.id)).for('update');
    if (!row || row.status !== 'active' || row.id !== auth.credentialId || row.accountId !== auth.accountId || openCredentialSecret(row).access !== auth.accessToken)
      throw new HttpError(409, 'Your ChatGPT connection changed before synchronization. Retry with the current account.');
    const credentialBinding = createHash('sha256').update(auth.accessToken).digest('hex');
    const rejection = accountRejection(auth, settings);
    if (rejection) throw new HttpError(403, rejection);
    const [previous] = await tx.select().from(personalCodexAccounts).where(eq(personalCodexAccounts.userId, person.id));
    if (previous?.connected && !previous.workspaceId.startsWith('siwc:')) throw new HttpError(409, 'Disconnect the stock Codex account before changing its authentication method.');
    await personalControl(person.id, 'sync-token', { accessToken: auth.accessToken, credentialBinding });
    if (!row.email) throw new HttpError(409, 'Reconnect ChatGPT before enabling stock Codex.');
    const binding = previous?.workspaceId === row.accountId && previous.email === row.email ? previous.credentialBinding : randomUUID();
    const values = { credentialBinding: binding, email: row.email, workspaceId: row.accountId, planType: row.planType ?? 'unknown', connected: true, updatedAt: new Date() };
    await tx.insert(personalCodexAccounts).values({ userId: person.id, ...values }).onConflictDoUpdate({ target: personalCodexAccounts.userId, set: values });
    return { synchronized: true };
  });
}
