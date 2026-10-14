import { z } from 'zod';
import { db } from '@/db';
import { auditLog } from '@/db/schema';
import { resolvePrincipal, type Principal } from '@/lib/auth/groups';
import { HttpError } from '@/lib/authz';
import { getSetting, type ChatGPTSettings } from '@/lib/settings';
import { assertNoCodexWork, lockPersonalOwner } from '@/personal-codex/accounts';
import { personalControl } from '@/personal-codex/control';
import type { EnrollmentReadiness } from '@/personal-codex/contracts';
import { userMayUseChatGPT } from './policy';
import { SIWCCredentialSchema } from './siwc';

export const runtimeConsent = z.object({ accepted: z.literal(true), consentVersion: z.literal(1) }).strict();
export type RuntimeConsent = z.infer<typeof runtimeConsent>;
export const localSignInReason = 'The local sign-in app is not available in this installation yet. It is needed to open OpenAI sign-in on your computer and securely connect this account.';

/** These are eligibility checks, never an authorization or account-identity claim. */
export function accountSetupEligibility(p: Principal, settings: ChatGPTSettings, installationHostId: string | undefined) {
  if (!userMayUseChatGPT(p, settings)) return { allowed: false, reason: settings.enabled
    ? 'Your account is not allowed to connect ChatGPT. Ask an administrator to review your access.'
    : 'ChatGPT connections are disabled. An administrator can enable them in Admin → Settings → ChatGPT.' };
  if (settings.allowedWorkspaceIds.some(value => value.trim())) return { allowed: false, reason: 'Your organization’s workspace restriction needs administrator review before this sign-in method can be used.' };
  if (!settings.allowPersonalPlans) return { allowed: false, reason: 'An administrator must allow personal ChatGPT subscription access before this account can connect.' };
  if (!SIWCCredentialSchema.shape.hostId.safeParse(installationHostId?.trim()).success) return { allowed: false, reason: 'An operator must finish this installation’s ChatGPT sign-in configuration.' };
  if (![p.user.email, p.user.upn].some(value => z.email().safeParse(value).success)) return { allowed: false, reason: 'Your CollectiveUI account needs an email binding before ChatGPT can be connected. Ask an administrator to verify your account details.' };
  return { allowed: true, reason: null };
}

export type AccountSetupView = {
  eligible: boolean;
  reason: string | null;
  runtime: EnrollmentReadiness | { state: 'not_installed' | 'unavailable'; selfEnrollment: false; enrolled: false; runtimeState?: undefined; reason: string };
  canPrepareRuntime: boolean;
  authentication: { state: 'companion_required'; reason: string };
};

/** Read-only projection: inspecting setup never enrolls a user or starts a container. */
export async function accountSetupView(p: Principal, settings: ChatGPTSettings): Promise<AccountSetupView> {
  const eligibility = accountSetupEligibility(p, settings, process.env.CHATGPT_SIWC_HOST_ID);
  let runtime: AccountSetupView['runtime'] = { state: 'not_installed', selfEnrollment: false, enrolled: false,
    reason: 'Private Codex runtime setup is not available in this installation.' };
  if (process.env.PERSONAL_CODEX_SOCKET) {
    try { runtime = await personalControl(p.user.id, 'readiness'); }
    catch { runtime = { state: 'unavailable', selfEnrollment: false, enrolled: false,
      reason: 'Private Codex setup could not be checked. Retry, or ask the operator to check the runtime service.' }; }
  }
  return { eligible: eligibility.allowed, reason: eligibility.reason, runtime,
    canPrepareRuntime: eligibility.allowed && runtime.state === 'ready' && (runtime.enrolled || runtime.selfEnrollment),
    authentication: { state: 'companion_required', reason: localSignInReason } };
}

/** Only explicit same-owner consent may prepare the preapproved isolated resources. */
export async function prepareAccountRuntime(p: Principal, rawConsent: RuntimeConsent) {
  if (!runtimeConsent.safeParse(rawConsent).success) throw new HttpError(400, 'Confirm your consent before preparing a private Codex runtime.');
  return db.transaction(async tx => {
    const person = await lockPersonalOwner(p.user.id, tx);
    if (person.disabled || person.sessionVersion !== p.user.sessionVersion) throw new HttpError(403, 'Sign in to CollectiveUI again.');
    const settings = await getSetting('chatgpt', tx);
    const eligibility = accountSetupEligibility(await resolvePrincipal(person, tx), settings, process.env.CHATGPT_SIWC_HOST_ID);
    if (!eligibility.allowed) throw new HttpError(403, eligibility.reason!);
    await assertNoCodexWork(person.id, tx);
    const result = await personalControl(person.id, 'prepare', { consentVersion: 1, sessionVersion: person.sessionVersion });
    if (result.state !== 'ready' || !result.enrolled || result.runtimeState !== 'running') throw new HttpError(409, result.reason || 'Private Codex runtime preparation is not complete. Check its status before retrying.');
    await tx.insert(auditLog).values({ actorId: person.id, action: 'chatgpt.codex.prepare', target: person.id,
      details: { consentVersion: 1, sessionVersion: person.sessionVersion } });
    return { prepared: true, runtime: result, authentication: { state: 'companion_required' as const, reason: localSignInReason } };
  });
}
