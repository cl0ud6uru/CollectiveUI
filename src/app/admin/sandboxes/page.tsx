import { eq, inArray } from "drizzle-orm";
import { SandboxAdmin, type SandboxRowView } from "@/components/admin/sandbox-admin";
import { AdminHeader } from "@/components/admin/ui";
import { db } from "@/db";
import { groups, users, workspaceTemplateVersions, workspaceTemplates } from "@/db/schema";
import { sandboxd } from "@/lib/sandbox/client";
import { workspaceConfigState } from "@/lib/sandbox/setup";
import { readWorkspaceSetup } from "@/lib/sandbox/setup-server";
import { listSandboxRows, listWorkspaceInstances } from "@/lib/sandbox/store";
import { requireAdminPage } from "@/lib/session";
import { getSetting } from "@/lib/settings";
import type { SandboxState } from "@/sandboxd/protocol/types";

export default async function AdminSandboxesPage() {
  await requireAdminPage();
  const client = workspaceConfigState(process.env) === "configured" ? sandboxd() : null;
  const [settings, groupRows, legacyRows, instances] = await Promise.all([
    getSetting("sandbox"),
    db.select({ id: groups.id, name: groups.name }).from(groups).orderBy(groups.name),
    listSandboxRows(),
    listWorkspaceInstances(),
  ]);
  const setup = await readWorkspaceSetup(settings.allowRunc);
  // An empty successful response proves absence; no response proves nothing.
  let states: SandboxState[] | null = null;
  let error: string | null = client ? null : "Workspace status is unavailable until portal configuration is complete. Run the setup check, then reload this page to retry the list.";
  if (client) {
    try {
      states = await client.list(15_000);
    } catch {
      error = "The workspace list could not be refreshed. Run the setup check, then reload this page to retry the list.";
    }
  }
  const ownerIds = [...new Set(instances.map((r) => r.ownerUserId))];
  const people = ownerIds.length
    ? await db.select({ id: users.id, name: users.name, upn: users.upn, disabled: users.disabled }).from(users).where(inArray(users.id, ownerIds))
    : [];
  const byRef = new Map((states ?? []).map((s) => [s.ref, s]));
  const templateVersionIds = [...new Set(instances.flatMap((r) => r.templateVersionId ? [r.templateVersionId] : []))];
  const templateVersions = templateVersionIds.length
    ? await db.select({ id: workspaceTemplateVersions.id, name: workspaceTemplates.name, version: workspaceTemplateVersions.version })
      .from(workspaceTemplateVersions).innerJoin(workspaceTemplates, eq(workspaceTemplateVersions.templateId, workspaceTemplates.id))
      .where(inArray(workspaceTemplateVersions.id, templateVersionIds))
    : [];
  const templateByVersion = new Map(templateVersions.map((r) => [r.id, `${r.name} · v${r.version}`]));
  const known = new Set([...legacyRows.map((r) => r.ref), ...instances.map((r) => r.sandboxRef)]);
  // People and states only: never refs to the browser (they would let a compromised admin page address sandboxd).
  const list: SandboxRowView[] = instances.map((r) => {
    const person = people.find((u) => u.id === r.ownerUserId);
    const s = byRef.get(r.sandboxRef);
    return {
      id: r.id,
      ownerUserId: r.ownerUserId,
      name: person?.name ?? "(unknown)",
      upn: person?.upn ?? "",
      disabled: !!person?.disabled,
      origin: r.origin,
      templateName: r.templateVersionId ? templateByVersion.get(r.templateVersionId) ?? "Template workspace" : "Legacy personal",
      provisionState: r.provisionState,
      state: s?.state ?? (states === null ? "unknown" : "missing"),
      runtime: s?.runtime ?? null,
      activeExecs: s?.activeExecs ?? 0,
      drift: !!s?.drift,
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
      deleteAfter: r.deleteAfter?.toISOString() ?? null,
    };
  });
  const orphans = (states ?? []).filter((s) => !known.has(s.ref)).map((s) => ({ ref: s.ref, state: s.state, createdAt: s.createdAt }));

  return (
    <div>
      <AdminHeader
        title="Workspaces"
        description="Private legacy and template workspaces. Every registered instance has its own persistent volume; containers have no network access or credentials."
      />
      <SandboxAdmin settings={settings} groups={groupRows} setup={setup} error={error} rows={list} orphans={orphans} />
    </div>
  );
}
