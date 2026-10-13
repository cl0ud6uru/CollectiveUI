import { formatAdminTimestamp } from "@/lib/admin/timestamp";

export function AdminTimestamp({ value }: { value: string | Date | number | null | undefined }) {
  const date = value == null ? null : new Date(value);
  if (!date || !Number.isFinite(date.getTime())) return <>—</>;
  const iso = date.toISOString();
  return <time dateTime={iso} title={iso}>{formatAdminTimestamp(date)}</time>;
}
