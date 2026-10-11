import { z } from 'zod';

/** Bot policy contains no endpoint, identity or credential. Funding never falls back. */
export const CodexPolicySchema = z.object({
  funding: z.enum(['api', 'chatgpt_subscription']),
  model: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9._-]+$/),
  effort: z.enum(['low', 'medium', 'high', 'xhigh']),
}).strict();
export type CodexPolicy = z.infer<typeof CodexPolicySchema>;
export const CODEX_DIRECT_ONLY = 'Codex supports direct text chats only in this pilot. Groups, routines, delegation, attachments and approval continuations are unavailable.';
export const CODEX_VERSION = '0.163.0-alpha.2';
