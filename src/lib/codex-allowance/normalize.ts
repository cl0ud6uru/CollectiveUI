import { z } from 'zod';
import type { QuotaField, QuotaWindow } from './contracts';
const Window = z.object({ usedPercent: z.number().finite().nonnegative().nullable().optional(), windowDurationMins: z.number().int().positive().nullable().optional(), resetsAt: z.number().int().nonnegative().nullable().optional() });
const Bucket = z.object({ limitId: z.string().min(1).max(200).nullable().optional(), limitName: z.string().max(200).nullable().optional(), primary: Window.nullable().optional(), secondary: Window.nullable().optional() });
const Payload = z.object({ rateLimits: Bucket.nullable().optional(), rateLimitsByLimitId: z.record(z.string().min(1).max(200), Bucket).nullable().optional() }).refine(value => value.rateLimits !== undefined || value.rateLimitsByLimitId !== undefined, 'Missing quota payload');
/** Omitted notification fields keep their original timestamps; explicit null removes only that window. */
export function normalizeQuota(raw: unknown, previous: QuotaWindow[], source: QuotaField['source'], now: Date): QuotaWindow[] {
  const parsed = Payload.parse(raw); const notification = source === 'account/rateLimits/updated';
  const windows = new Map((notification ? previous : []).map(w => [`${w.limitId}:${w.kind}`, w]));
  const buckets = parsed.rateLimitsByLimitId !== undefined && parsed.rateLimitsByLimitId !== null ? Object.entries(parsed.rateLimitsByLimitId)
    : parsed.rateLimits ? [[parsed.rateLimits.limitId ?? 'provider-default', parsed.rateLimits] as const] : [];
  if (buckets.length > 100) throw new Error('Too many allowance buckets');
  for (const [id, bucket] of buckets) {
    // The map key is the documented metered limit id. Never combine disagreeing identities.
    if (bucket.limitId && bucket.limitId !== id) throw new Error('Allowance identity mismatch');
    for (const kind of ['primary', 'secondary'] as const) {
      const key = `${id}:${kind}`; const rawWindow = bucket[kind];
      if (rawWindow === null) { windows.delete(key); continue; }
      if (rawWindow === undefined) continue;
      const prior = windows.get(key); const observedAt = now.toISOString();
      const field = (name: 'usedPercent' | 'windowDurationMins' | 'resetsAt'): QuotaField => rawWindow[name] !== undefined
        ? { value: rawWindow[name] ?? null, observedAt, source } : prior?.[name] ?? { value: null, observedAt, source };
      windows.set(key, { limitId: id, limitName: bucket.limitName !== undefined ? bucket.limitName : prior?.limitName ?? null, kind,
        usedPercent: field('usedPercent'), windowDurationMins: field('windowDurationMins'), resetsAt: field('resetsAt') });
    }
  }
  if (windows.size > 200) throw new Error('Too many allowance windows');
  return [...windows.values()];
}
