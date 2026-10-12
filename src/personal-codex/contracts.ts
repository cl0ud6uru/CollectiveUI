import { z } from 'zod';

export const ownerId = z.string().min(1).max(256).regex(/^[a-zA-Z0-9_-]+$/);
export const connectionAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('connect') }).strict(),
  z.object({ action: z.literal('confirm') }).strict(),
  z.object({ action: z.literal('cancel') }).strict(),
  z.object({ action: z.literal('disconnect') }).strict(),
  z.object({ action: z.literal('start') }).strict(),
]);
export const nativeAccount = z.object({ account: z.object({ type: z.literal('chatgpt'), email: z.string().email(), planType: z.string().max(128) }).nullable(),
  workspaceRouting: z.object({ chatgptAccountId: z.string().min(1).max(256), backendOrigin: z.string().url(), accountRoutingOverride: z.enum(['us', 'us_cr', 'NO_CONSTRAINT']) }).nullable() });
export const pendingLogin = z.object({ type: z.literal('chatgptDeviceCode'), loginId: z.string().min(1).max(256),
  verificationUrl: z.literal('https://auth.openai.com/codex/device'), userCode: z.string().regex(/^[A-Z0-9-]{4,32}$/) });
export type NativeAccount = z.infer<typeof nativeAccount>;
export type ConnectionView = {
  state: 'unavailable' | 'not_started' | 'stopped' | 'signed_out' | 'pending' | 'uncertain' | 'confirm' | 'connected' | 'changed';
  canConnect?: boolean;
  email?: string; workspaceId?: string; planType?: string;
  login?: { verificationUrl: string; userCode: string };
};
export type BrokerStatus = { state: 'not_started' | 'stopped' | 'running'; account?: NativeAccount; loginUncertain?: true; login?: z.infer<typeof pendingLogin> };
