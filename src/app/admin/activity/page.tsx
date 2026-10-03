import { requireAdminPage } from "@/lib/session";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { AdminHeader, Badge, Table, Td } from "@/components/admin/ui";
import { db } from "@/db";
import { auditLog, bots, routineRuns, routines, toolCalls, users } from "@/db/schema";

const tone = (s: string) =>
  s === "done" || s === "succeeded" ? "green" : s === "error" || s === "failed" || s === "denied" ? "red" : s.includes("approval") ? "amber" : "default";

export default async function AdminActivityPage(props: PageProps<"/admin/activity">) {
  const p = await requireAdminPage();
  const privateScope = sql`(not exists (select 1 from ai_apps personal where personal.id = ${bots.appId} and personal.provider_config->'docker' is not null) or ${bots.ownerId} = ${p.user.id})`;
  const sp = await props.searchParams;
  const tab = sp.tab === "runs" ? "runs" : sp.tab === "audit" ? "audit" : "tools";
  const tool = typeof sp.tool === "string" ? sp.tool : "";
  const filters: SQL[] = [privateScope];
  if (tool) filters.push(eq(toolCalls.toolName, tool));

  const tabs = (
    <div className="mb-4 flex gap-1 border-b border-border text-sm">
      {[
        ["tools", "Tool calls"],
        ["runs", "Routine runs"],
        ["audit", "Admin audit log"],
      ].map(([k, label]) => (
        <a key={k} href={`?tab=${k}`} className={`-mb-px border-b-2 px-3 py-2 ${tab === k ? "border-fg font-medium" : "border-transparent text-muted"}`}>
          {label}
        </a>
      ))}
    </div>
  );

  if (tab === "runs") {
    const runs = await db
      .select({ run: routineRuns, routine: routines.name, bot: bots.name, owner: users.name })
      .from(routineRuns)
      .innerJoin(routines, eq(routines.id, routineRuns.routineId))
      .innerJoin(bots, eq(bots.id, routines.botId))
      .innerJoin(users, eq(users.id, routines.ownerId))
      .where(privateScope)
      .orderBy(desc(routineRuns.createdAt))
      .limit(200);
    return (
      <div>
        <AdminHeader title="Activity" />
        {tabs}
        <Table head={["When", "Routine", "Bot", "Owner", "Trigger", "Status", "Error"]}>
          {runs.map(({ run, routine, bot, owner }) => (
            <tr key={run.id}>
              <Td className="whitespace-nowrap text-xs text-muted">{run.createdAt.toLocaleString()}</Td>
              <Td>{routine}</Td>
              <Td>{bot}</Td>
              <Td>{owner}</Td>
              <Td className="text-xs">{run.trigger}</Td>
              <Td>
                <Badge tone={tone(run.status)}>{run.status.replace(/_/g, " ")}</Badge>
              </Td>
              <Td className="max-w-[240px] truncate text-xs text-danger">{run.error}</Td>
            </tr>
          ))}
        </Table>
      </div>
    );
  }

  if (tab === "audit") {
    const rows = await db
      .select({ a: auditLog, actor: users.name })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorId))
      .orderBy(desc(auditLog.createdAt))
      .limit(300);
    return (
      <div>
        <AdminHeader title="Activity" />
        {tabs}
        <Table head={["When", "Actor", "Action", "Target", "Details"]}>
          {rows.map(({ a, actor }) => (
            <tr key={a.id}>
              <Td className="whitespace-nowrap text-xs text-muted">{a.createdAt.toLocaleString()}</Td>
              <Td>{actor}</Td>
              <Td className="font-mono text-xs">{a.action}</Td>
              <Td className="font-mono text-xs">{a.target}</Td>
              <Td className="max-w-[320px] truncate font-mono text-xs text-muted">{a.details ? JSON.stringify(a.details) : ""}</Td>
            </tr>
          ))}
        </Table>
      </div>
    );
  }

  const calls = await db
    .select({ c: toolCalls, user: users.name, bot: bots.name })
    .from(toolCalls)
    .leftJoin(users, eq(users.id, toolCalls.userId))
    .leftJoin(bots, eq(bots.id, toolCalls.botId))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(toolCalls.createdAt))
    .limit(300);
  return (
    <div>
      <AdminHeader title="Activity" description="Every tool call made by bots, including approvals and denials." />
      {tabs}
      {tool && (
        <p className="mb-2 text-sm">
          Filtered by <code>{tool}</code> · <a href="?tab=tools" className="underline">clear</a>
        </p>
      )}
      <Table head={["When", "User", "Bot", "Tool", "Status", "Input"]}>
        {calls.map(({ c, user, bot }) => (
          <tr key={c.id}>
            <Td className="whitespace-nowrap text-xs text-muted">{c.createdAt.toLocaleString()}</Td>
            <Td>{user}</Td>
            <Td>{bot}</Td>
            <Td>
              <a href={`?tab=tools&tool=${encodeURIComponent(c.toolName)}`} className="font-mono text-xs hover:underline">
                {c.toolName}
              </a>
            </Td>
            <Td>
              <Badge tone={tone(c.status)}>{c.status.replace(/_/g, " ")}</Badge>
            </Td>
            <Td className="max-w-[320px] truncate font-mono text-xs text-muted">{JSON.stringify(c.input)}</Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}
