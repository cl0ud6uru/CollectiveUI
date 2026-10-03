import { inArray } from "drizzle-orm";
import { SandboxAdmin, type SandboxRowView } from "@/components/admin/sandbox-admin";
import { AdminHeader } from "@/components/admin/ui";
import { db } from "@/db";
import { groups, users } from "@/db/schema";
import { SandboxError, sandboxd } from "@/lib/sandbox/client";
import { listSandboxRows } from "@/lib/sandbox/store";
import { requireAdminPage } from "@/lib/session";
import { getSetting } from "@/lib/settings";
import type { Health, SandboxState } from "@/sandboxd/protocol/types";

export default async function AdminSandboxesPage() {
  await requireAdminPage();
  const client = sandboxd();
  const [settings, groupRows, rows] = await Promise.all([
    getSetting("sandbox"),
    db.select({ id: groups.id, name: groups.name }).from(groups).orderBy(groups.name),
    listSandboxRows(),
  ]);
  let health: Health | null = null;
  let states: SandboxState[] = [];
  let error: string | null = null;
  if (client) {
    try {
      [health, states] = await Promise.all([client.health(), client.list()]);
    } catch (err) {
      error = err instanceof SandboxError ? err.message : "The workspace service isn't reachable.";
    }
  }
  const people = rows.length
    ? await db.select({ id: users.id, name: users.name, upn: users.upn, disabled: users.disabled }).from(users).where(inArray(users.id, rows.map((r) => r.userId)))
    : [];
  const byRef = new Map(states.map((s) => [s.ref, s]));
  const known = new Set(rows.map((r) => r.ref));
  // People and states only: never refs to the browser (they would let a compromised admin page address sandboxd).
  const list: SandboxRowView[] = rows.map((r) => {
    const person = people.find((u) => u.id === r.userId);
    const s = byRef.get(r.ref);
    return {
      userId: r.userId,
      name: person?.name ?? "(unknown)",
      upn: person?.upn ?? "",
      disabled: !!person?.disabled,
      state: s?.state ?? (error ? "unknown" : "missing"),
      runtime: s?.runtime ?? null,
      activeExecs: s?.activeExecs ?? 0,
      drift: !!s?.drift,
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
      deleteAfter: r.deleteAfter?.toISOString() ?? null,
    };
  });
  const orphans = states.filter((s) => !known.has(s.ref)).map((s) => ({ ref: s.ref, state: s.state, createdAt: s.createdAt }));

  return (
    <div>
      <AdminHeader
        title="Workspaces"
        description="Each person's private sandbox where bots run commands and edit files. No network access, no secrets, one container per person."
      />
      <SandboxAdmin settings={settings} groups={groupRows} configured={!!client} health={health} error={error} rows={list} orphans={orphans} />
    </div>
  );
}
