import { AdminHeader, Card, Stat, Table, Td } from "@/components/admin/ui";
import { requireAdminPage } from "@/lib/session";
import { usageSummary } from "@/lib/usage";

const n = (v: number | string) => Number(v).toLocaleString();

export default async function AdminUsagePage() {
  await requireAdminPage();
  const { totals, daily, byApp, byUser } = await usageSummary(30);
  const max = Math.max(1, ...daily.map((d) => Number(d.messages)));
  const fb = Number(totals.thumbs_up) + Number(totals.thumbs_down);
  return (
    <div>
      <AdminHeader
        title="Usage"
        description="Last 30 days"
        actions={
          <a href="/api/admin/usage.csv" className="rounded-full border border-border px-4 py-2 text-sm hover:bg-hover">
            Export CSV
          </a>
        }
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Active users" value={n(totals.active_users)} sub={`${n(totals.users)} total`} />
        <Stat label="Conversations" value={n(totals.conversations)} />
        <Stat label="Messages" value={n(totals.messages)} />
        <Stat
          label="Tokens"
          value={n(Number(totals.input_tokens) + Number(totals.output_tokens))}
          sub={`${n(totals.input_tokens)} in (${n(totals.cache_read_tokens)} cached) · ${n(totals.output_tokens)} out`}
        />
        <Stat label="Bots" value={n(totals.bots)} />
        <Stat label="Tool calls" value={n(totals.tool_calls)} />
        <Stat label="Satisfaction" value={fb ? `${Math.round((Number(totals.thumbs_up) / fb) * 100)}%` : "—"} sub={`${n(totals.thumbs_up)} 👍 · ${n(totals.thumbs_down)} 👎`} />
      </div>
      <Card className="mt-6">
        <div className="mb-3 text-sm font-medium">Assistant messages per day</div>
        <div className="flex h-40 items-end gap-1" role="img" aria-label="Messages per day chart">
          {daily.map((d) => (
            <div key={d.day} className="group relative flex-1">
              <div className="rounded-t bg-accent/80 hover:bg-accent" style={{ height: `${(Number(d.messages) / max) * 150 + 2}px` }} />
              <div className="pointer-events-none absolute bottom-full left-1/2 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-black px-2 py-1 text-xs text-white group-hover:block">
                {d.day}: {d.messages} msgs, {n(d.tokens)} tokens
              </div>
            </div>
          ))}
        </div>
      </Card>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div>
          <div className="mb-2 text-sm font-medium">By model / bot</div>
          <Table head={["Name", "Replies", "Tokens"]}>
            {byApp.map((r) => (
              <tr key={r.name}>
                <Td>{r.name}</Td>
                <Td className="tabular-nums">{n(r.messages)}</Td>
                <Td className="tabular-nums">{n(r.tokens)}</Td>
              </tr>
            ))}
          </Table>
        </div>
        <div>
          <div className="mb-2 text-sm font-medium">Top users</div>
          <Table head={["User", "Replies", "Tokens"]}>
            {byUser.map((r) => (
              <tr key={r.upn}>
                <Td>
                  {r.name} <span className="text-xs text-subtle">{r.upn}</span>
                </Td>
                <Td className="tabular-nums">{n(r.messages)}</Td>
                <Td className="tabular-nums">{n(r.tokens)}</Td>
              </tr>
            ))}
          </Table>
        </div>
      </div>
    </div>
  );
}
