/** Client-safe, normalized provider facts; no credential or raw provider response. */
export type ReadStatus = 'known' | 'unset' | 'permission_denied' | 'unsupported' | 'unavailable' | 'unknown';
export type SpendLimit = { status: ReadStatus; amount: number | null; currency: string | null; enforcement: string | null; httpStatus?: number };
export type Money = { value: number; currency: string };
export type DailySpend = { start: number; end: number; amounts: Money[] };
export type SpendingSnapshot = {
  organization: string; month: string; start: number; through: number; refreshedAt: string;
  costsStatus: ReadStatus; amounts: Money[]; daily: DailySpend[];
  breakdownStatus: ReadStatus; projects: { id: string | null; amounts: Money[] }[];
  organizationLimit: SpendLimit; projectLimits: Record<string, SpendLimit>;
};
export type BillingAccountView = {
  id: string; name: string; organization: string; enabled: boolean; showHealthBar: boolean;
  snapshot: SpendingSnapshot | null; lastAttemptAt: string | null; lastError: string | null;
};
export const STALE_AFTER_MS = 15 * 60_000;
export const BILLING_REFRESH_INTERVAL_MS = 5 * 60_000;
export const BILLING_REFRESH_COOLDOWN_MS = 60_000;
export function snapshotStale(snapshot: SpendingSnapshot, now = Date.now()) {
  const refreshedAt = Date.parse(snapshot.refreshedAt);
  return !Number.isFinite(refreshedAt) || now - refreshedAt > STALE_AFTER_MS || snapshot.month !== new Date(now).toISOString().slice(0, 7);
}
export function limitDescription(limit: SpendLimit | undefined) {
  if (!limit) return 'No limit was read for this project. Remaining allowance cannot be calculated.';
  if (limit.status === 'known') return `Provider enforcement: ${limit.enforcement ?? 'unknown'}`;
  if (limit.status === 'permission_denied') return 'OpenAI denied access to this limit. Costs can still be available separately.';
  if (limit.status === 'unsupported') return 'OpenAI does not support this limit endpoint for this account.';
  if (limit.status === 'unset') return 'OpenAI returned no configured limit. This does not establish unlimited spending.';
  if (limit.httpStatus === 404) return 'OpenAI did not expose this limit for this account (HTTP 404). This does not mean no limit is set.';
  if (limit.status === 'unavailable') return 'The limit request failed or is unavailable from OpenAI. A successful costs refresh does not establish a limit.';
  return 'No recognized monthly limit was returned by OpenAI. Remaining allowance cannot be calculated.';
}
export function remaining(limit: SpendLimit, amounts: Money[], known: boolean): Money | null {
  if (!known || limit.status !== 'known' || limit.amount === null || !limit.currency) return null;
  // A multi-currency total cannot safely be compared to a single-currency threshold.
  if (amounts.some(a => a.currency !== limit.currency)) return null;
  const spent = amounts.find(a => a.currency === limit.currency)?.value ?? 0;
  return { value: Math.max(0, limit.amount - spent), currency: limit.currency };
}
export function applicableRemaining(snapshot: SpendingSnapshot, project: string | null, now = Date.now()): Money | null {
  if (snapshotStale(snapshot, now)) return null;
  const org = remaining(snapshot.organizationLimit, snapshot.amounts, snapshot.costsStatus === 'known');
  if (!project) return org;
  const row = snapshot.projects.find(p => p.id === project);
  const limit = snapshot.projectLimits[project];
  if (!limit || !row || !org) return null;
  const own = remaining(limit, row.amounts, snapshot.breakdownStatus === 'known');
  if (!own || own.currency !== org.currency) return null;
  return { value: Math.min(org.value, own.value), currency: org.currency };
}
export function moneyText(money: Money | null) {
  if (!money) return 'Unknown';
  return `${money.currency} ${money.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
