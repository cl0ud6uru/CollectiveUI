/** Fixed locale and zone keep server-rendered and hydrated admin timestamps identical. */
export function formatAdminTimestamp(value: string | Date | number | null | undefined): string {
  if (value == null) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit",
    timeZone: "UTC", timeZoneName: "short",
  }).format(date);
}
