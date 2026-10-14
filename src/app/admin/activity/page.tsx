import Link from "next/link";
import { requireAdminPage } from "@/lib/session";
import { AdminHeader, Badge, Table, Td } from "@/components/admin/ui";
import { AdminPagination } from "@/components/admin/pagination";
import { AdminTimestamp } from "@/components/admin/timestamp";
import { ACTIVITY_STATUSES, listAdminActivity, readActivityFilters } from "@/lib/admin/activity";
import { adminListHref } from "@/lib/admin/listing";

const tone = (status: string) => status === "done" || status === "succeeded" ? "green"
  : status === "error" || status === "failed" || status === "denied" ? "red" : status.includes("approval") ? "amber" : "default";
const control = "mt-1 block h-10 w-full min-w-0 rounded-lg border border-border bg-surface px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2";

export default async function AdminActivityPage(props: PageProps<"/admin/activity">) {
  const principal = await requireAdminPage();
  const filters = readActivityFilters(await props.searchParams);
  const { values, errors } = filters;
  const { tab } = values;
  const { rows, window } = await listAdminActivity(principal, filters);
  const isAudit = tab === "audit";
  const isTools = tab === "tools";
  const clearHref = adminListHref("/admin/activity", { tab });
  const hasFilters = Object.entries(values).some(([key, value]) => key !== "tab" && value);
  return <div>
    <AdminHeader title="Activity" description="Inspect tool calls, routine runs and administrator changes. Dates and times are shown in UTC." />
    <nav aria-label="Activity views" className="mb-4 flex flex-wrap gap-1 border-b border-border text-sm">
      {[["tools", "Tool calls"], ["runs", "Routine runs"], ["audit", "Admin audit log"]].map(([key, label]) =>
        <Link key={key} href={adminListHref("/admin/activity", { tab: key })} aria-current={tab === key ? "page" : undefined}
          className={`-mb-px border-b-2 px-3 py-2 ${tab === key ? "border-fg font-medium" : "border-transparent text-muted"}`}>{label}</Link>)}
    </nav>
    <form action="/admin/activity" className="mb-4 grid gap-3 rounded-xl border border-border p-4 sm:grid-cols-2 lg:grid-cols-3">
      <input type="hidden" name="tab" value={tab} />
      <label className="min-w-0 text-sm">From date (UTC)<input className={control} type="date" name="from" defaultValue={values.from} /></label>
      <label className="min-w-0 text-sm">Through date (UTC)<input className={control} type="date" name="to" defaultValue={values.to} /></label>
      <label className="min-w-0 text-sm">{isAudit ? "Actor" : "User"}<input className={control} name="user" maxLength={200} defaultValue={values.user} placeholder="Name or UPN" /></label>
      {!isAudit && <label className="min-w-0 text-sm">Status<select className={control} name="status" defaultValue={values.status}>
        <option value="">All statuses</option>
        {ACTIVITY_STATUSES[tab].map(status => <option key={status} value={status}>{status.replaceAll("_", " ")}</option>)}
      </select></label>}
      {isTools && <label className="min-w-0 text-sm">Tool name<input className={control} name="tool" maxLength={200} defaultValue={values.tool} placeholder="Exact tool name" /></label>}
      {isAudit && <label className="min-w-0 text-sm">Action<input className={control} name="action" maxLength={200} defaultValue={values.action} placeholder="For example, group.update" /></label>}
      <div className="flex items-end gap-3"><button className="h-10 rounded-lg border border-border px-4 text-sm hover:bg-hover" type="submit">Apply filters</button>
        {hasFilters && <Link className="px-2 py-2 text-sm underline" href={clearHref}>Clear filters</Link>}
      </div>
    </form>
    {errors.length > 0 && <p role="alert" className="mb-3 text-sm text-danger">{errors.join(" ")}</p>}
    <AdminPagination window={window} path="/admin/activity" filters={values} noun="records" />
    <Table head={isAudit ? ["When", "Actor", "Action", "Target", "Details"] : ["When", "User", "Bot", isTools ? "Tool" : "Routine", "Status", "Details"]}>
      {rows.map(row => <tr key={row.id}>
        <Td className="text-xs text-muted"><AdminTimestamp value={row.createdAt} /></Td>
        <Td><span>{row.user ?? "Deleted user / system"}</span>{row.upn && <span className="block text-xs text-muted">{row.upn}</span>}</Td>
        {!isAudit && <Td>{row.bot ?? "—"}</Td>}
        <Td className="break-words text-xs">{isTools
          ? <Link href={adminListHref("/admin/activity", { ...values, tool: row.subject })} className="font-mono underline-offset-4 hover:underline">{row.subject}</Link>
          : row.subject}</Td>
        {isAudit ? <Td className="break-words font-mono text-xs">{row.target ?? "—"}</Td>
          : <Td><Badge tone={tone(row.status!)}>{row.status!.replaceAll("_", " ")}</Badge></Td>}
        <Td>
          <details className="min-w-40 max-w-2xl">
            <summary className="cursor-pointer rounded px-1 py-1 text-sm underline-offset-4 hover:underline focus-visible:outline-2" aria-label={`View details for ${row.subject} ${row.id}`}>View details</summary>
            <pre className="mt-2 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-mono text-xs [overflow-wrap:anywhere]" tabIndex={0} aria-label="Record details">{row.details}</pre>
            {row.conversationId && <Link href={`/c/${encodeURIComponent(row.conversationId)}`} className="mt-2 inline-block text-sm underline">Open my conversation</Link>}
          </details>
        </Td>
      </tr>)}
      {!rows.length && <tr><Td colSpan={isAudit ? 5 : 6} className="py-8 text-center text-muted">
        {hasFilters ? <>No activity matches these filters. <Link href={clearHref} className="underline">Clear filters</Link></> : "No activity has been recorded in this view yet."}
      </Td></tr>}
    </Table>
    {window.pages > 1 && <AdminPagination window={window} path="/admin/activity" filters={values} noun="records" />}
  </div>;
}
