import { z } from 'zod';
import { createHash } from 'node:crypto';

export const ownerId = z.string().min(1).max(256).regex(/^[a-zA-Z0-9_-]+$/);
export const connectionAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('connect'), accepted: z.literal(true), consentVersion: z.literal(1) }).strict(),
  z.object({ action: z.literal('confirm'), accepted: z.literal(true), consentVersion: z.literal(1),
    expected: z.object({ email: z.string().email().max(320), workspaceId: z.string().min(1).max(256) }).strict() }).strict(),
  z.object({ action: z.literal('cancel') }).strict(),
  z.object({ action: z.literal('disconnect') }).strict(),
  z.object({ action: z.literal('start') }).strict(),
  z.object({ action: z.literal('refresh') }).strict(),
]);
export const tokenSyncRequest = z.object({ accessToken: z.string().min(1).max(16_384), credentialBinding: z.string().min(1).max(256) }).strict();
export const tokenFingerprint = (accessToken: string) => createHash('sha256').update(accessToken).digest('hex');
export const nativeAccount = z.object({ account: z.object({ type: z.literal('chatgpt'), email: z.string().email(), planType: z.string().max(128) }).nullable(),
  workspaceRouting: z.object({ chatgptAccountId: z.string().min(1).max(256), backendOrigin: z.string().url(), accountRoutingOverride: z.enum(['us', 'us_cr', 'NO_CONSTRAINT']) }).nullable().optional().default(null) });
export const pendingLogin = z.object({ type: z.literal('chatgptDeviceCode'), loginId: z.string().min(1).max(256),
  verificationUrl: z.literal('https://auth.openai.com/codex/device'), userCode: z.string().regex(/^[A-Z0-9-]{4,32}$/) });
export type NativeAccount = z.infer<typeof nativeAccount>;
export type ConnectionView = {
  state: 'unavailable' | 'not_started' | 'stopped' | 'signed_out' | 'pending' | 'uncertain' | 'confirm' | 'connected' | 'changed' | 'expired' | 'failed';
  canConnect?: boolean;
  email?: string; workspaceId?: string; planType?: string;
  login?: { verificationUrl: string; userCode: string; expiresAt: string };
  reason?: string;
};
export type SiwcStatus = { available: boolean; credentialBinding?: string; reason?: string };
export type BrokerStatus = { state: 'not_started' | 'stopped' | 'running'; account?: NativeAccount; loginUncertain?: true; login?: z.infer<typeof pendingLogin> & { expiresAt: string }; loginOutcome?: 'expired' | 'failed'; siwc?: SiwcStatus };
export type SiwcSyncResult = { state: 'running'; credential: 'synchronized'; siwc: SiwcStatus };
export type PersonalControlResult = BrokerStatus | SiwcSyncResult;

export const enrollmentRequest = z.object({ consentVersion: z.literal(1), sessionVersion: z.number().int().nonnegative() }).strict();
export const enrollmentReadinessSchema = z.object({
  state: z.enum(['ready', 'operator_setup_required', 'verification_required', 'unavailable']),
  selfEnrollment: z.boolean(), enrolled: z.boolean(),
  runtimeState: z.enum(['not_started', 'stopped', 'running']).optional(),
  reason: z.enum(['An operator must enable enrollment for this installation.', 'An operator must verify the stock sandbox before enrollment.', 'Installed runtime resources require operator reconciliation.', 'SBX runtime preparation is operator managed; self enrollment is unavailable.']).optional(),
}).strict();
export type EnrollmentReadiness = z.infer<typeof enrollmentReadinessSchema>;

/** Browser-safe projection; resource readiness never implies a ChatGPT credential. */
export type AccountSetupView = {
  eligible: boolean;
  reason: string | null;
  runtime: EnrollmentReadiness | { state: 'not_installed' | 'unavailable'; selfEnrollment: false; enrolled: false; runtimeState?: undefined; reason: string };
  canPrepareRuntime: boolean;
  authentication: { state: 'companion_required' | 'companion_ready'; reason: string; downloadUrl?: string };
};

export type CompanionSignInView = { state: 'created' | 'paired' | 'receiving' | 'complete' | 'cancelled' | 'needs_attention' | 'expired'; expiresAt: string; reason?: string };
