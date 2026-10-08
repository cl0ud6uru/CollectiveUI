/** Client-safe allowance facts, independent of API money and token activity. */
export type QuotaField = { value: number | null; observedAt: string; source: 'account/rateLimits/read' | 'account/rateLimits/updated' };
export type QuotaWindow = { limitId: string; limitName: string | null; kind: 'primary' | 'secondary'; usedPercent: QuotaField; windowDurationMins: QuotaField; resetsAt: QuotaField };
export type CodexAllowanceView = {
  state: 'disabled' | 'unavailable' | 'needs_auth' | 'ready' | 'error';
  runtimeLabel: string | null; source: 'codex_app_server'; windows: QuotaWindow[];
  lastReadAt: string | null; message: string | null;
};
export function quotaStale(window: QuotaWindow, now = Date.now()) {
  const at = Date.parse(window.usedPercent.observedAt);
  return now - at > 5 * 60_000 || (window.resetsAt.value !== null && now >= window.resetsAt.value * 1000);
}
