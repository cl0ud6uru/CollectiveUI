import { z } from 'zod';
import { TEAM_MODEL_PURPOSES } from './model-policy';

const identifier = z.string().min(1).max(200);
/** Server-owned dispatch intent only. Never accept credentials, endpoints, profile paths or native arguments. */
export const TeamRunAdmissionDetailsSchema = z.object({
  version: z.literal(1), routeId: identifier, adapterId: identifier,
  integration: z.enum(['admin_inference_gateway','hermes_native_codex','openai_chatgpt_plan_usage']),
  model: identifier, billing: z.enum(['admin','personal']), connectionId: identifier.nullable(),
  gatewayGrantId: identifier.nullable(),
  evidence: z.object({ id: identifier, hermesRevision: z.string().regex(/^[a-f0-9]{40}$/), verifiedAt: z.number().finite(), expiresAt: z.number().finite() }).strict(),
  purposes: z.partialRecord(z.enum(TEAM_MODEL_PURPOSES), z.object({ usageReceiptId: identifier.nullable() }).strict()).refine(v => Object.keys(v).length > 0, 'At least one admitted purpose is required.'),
}).strict();
export type TeamRunAdmissionDetails = z.infer<typeof TeamRunAdmissionDetailsSchema>;
