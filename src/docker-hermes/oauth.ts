import { z } from 'zod';
import { revision } from './settings';

export const codexAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), requestId: z.string().uuid(), revision }).strict(),
  z.object({ action: z.literal('poll'), sessionId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('cancel'), sessionId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('disconnect'), revision }).strict(),
]);
export type CodexAction = z.infer<typeof codexAction>;
export const codexStates = ['disconnected', 'pending', 'connected', 'cancelled', 'expired', 'error', 'interrupted', 'blocked'] as const;
/** Allowlist at the broker boundary; native tokens, account details and exception text never pass. */
export const codexStatus = z.object({
  state: z.enum(codexStates),
  sessionId: z.string().uuid().optional(),
  userCode: z.string().regex(/^[A-Z0-9-]{3,32}$/).optional(),
  verificationUrl: z.literal('https://auth.openai.com/codex/device').optional(),
  expiresAt: z.number().finite().positive().optional(),
  nextPollAt: z.number().finite().positive().optional(),
}).strict();
export type CodexStatus = z.infer<typeof codexStatus>;
