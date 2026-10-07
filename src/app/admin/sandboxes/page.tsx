import { inArray } from "drizzle-orm";
import { SandboxAdmin, type SandboxRowView } from "@/components/admin/sandbox-admin";
import { AdminHeader } from "@/components/admin/ui";
import { db } from "@/db";
import { groups, users } from "@/db/schema";
import { sandboxd } from "@/lib/sandbox/client";
import { workspaceConfigState } from "@/lib/sandbox/setup";
import { readWorkspaceSetup } from "@/lib/sandbox/setup-server";
import { listSandboxRows } from "@/lib/sandbox/store";
import { requireAdminPage } from "@/lib/session";
import { getSetting } from "@/lib/settings";
import type { SandboxState } from "@/sandboxd/protocol/types";

export default async function AdminSandboxesPage() {
  await requireAdminPage();
  const client = workspaceConfigState(process.env) === "configured" ? sandboxd() : null;
  const [settings, groupRows, rows] = await Promise.all([
    getSetting("sandbox"),
    db.select({ id: groups.id, name: groups.name }).from(groups).orderBy(groups.name),
    listSandboxRows(),
  ]);
  const setup = await readWorkspaceSetup(settings.allowRunc);
  let states: SandboxState[] = [];
  let error: string | null = null;
  if (client) {
    try {
      states = await client.list(15_000);
    } catch {
      error = "The workspace list could not be refreshed. Run the setup check, then reload this page to retry the list.";
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
      <SandboxAdmin settings={settings} groups={groupRows} setup={setup} error={error} rows={list} orphans={orphans} />
    </div>
  );
}
