import Link from "next/link";
import { DockerHermesEnrollment } from '@/components/admin/docker-hermes-enrollment';
import { dockerBrokerReadiness } from '@/lib/docker-hermes/enrollment';
import { db } from "@/db";
import { aiApps, bots, hermesConnections, hermesProvisions, users, dockerHermesEnrollments } from "@/db/schema";
import { requireAdminPage } from "@/lib/session";
import { AdminHeader } from "@/components/admin/ui";
import { HermesAdmin } from "@/components/admin/hermes-admin";
import { cn } from "@/lib/utils";

const TABS = [
  { key: "personal", label: "Personal runtimes", hint: "Docker, started by each person" },
  { key: "manual", label: "Manual runtimes", hint: "Registered by an operator" },
] as const;

export default async function HermesAdminPage(props: PageProps<"/admin/hermes">) {
  await requireAdminPage();
  const tab = (await props.searchParams).tab === "manual" ? "manual" : "personal";
  const [people, connections, profiles, apps, definitions, enrollments, readiness] = await Promise.all([
    db.select({ id: users.id, name: users.name, upn: users.upn }).from(users).orderBy(users.name),
    db.select({ id: hermesConnections.id, userId: hermesConnections.userId, boundaryId: hermesConnections.boundaryId, enabled: hermesConnections.enabled, quota: hermesConnections.quota }).from(hermesConnections),
    db.select({ id: hermesProvisions.id, userId: hermesProvisions.userId, botId: hermesProvisions.botId, appId: hermesProvisions.appId, profile: hermesProvisions.profile, status: hermesProvisions.status, attempts: hermesProvisions.attempts, error: hermesProvisions.error }).from(hermesProvisions),
    db.select({ id: aiApps.id, name: aiApps.name, providerConfig: aiApps.providerConfig }).from(aiApps),
    db.select({ id: bots.id, name: bots.name, appId: bots.appId }).from(bots),
    db.select().from(dockerHermesEnrollments),
    dockerBrokerReadiness(),
  ]);
  const allowed = enrollments.filter(e => e.enabled).length;
  const counts = { personal: allowed, manual: connections.length };
  return <div>
    <AdminHeader title="Managed Hermes" description="Give people their own private Hermes agent for bots. To connect an existing Hermes profile instead, use Connections → Agent backends." />
    <nav aria-label="Hermes runtime type" className="mb-6 grid gap-2 sm:grid-cols-2">
      {TABS.map(({ key, label, hint }) => <Link key={key} href={key === "personal" ? "/admin/hermes" : "/admin/hermes?tab=manual"} aria-current={tab === key ? "page" : undefined}
        className={cn("rounded-2xl border px-4 py-3 transition-colors", tab === key ? "border-fg/40 bg-surface-2" : "border-border hover:bg-hover")}>
        <span className="flex items-center justify-between gap-2 text-sm font-medium">{label}<span className="text-xs font-normal text-muted tabular-nums">{counts[key]} {key === "personal" ? "allowed" : "registered"}</span></span>
        <span className="mt-0.5 block text-xs text-muted">{hint}</span>
      </Link>)}
    </nav>
    {tab === "personal"
      ? <DockerHermesEnrollment readiness={readiness} legacyConfigured={!!process.env.DOCKER_HERMES_ALLOWED_USER_IDS?.trim()} people={people.map(person => {
          const row = enrollments.find(e => e.userId === person.id);
          return { ...person, enabled: row?.enabled ?? false, cleanup: row?.cleanup ?? 'none', error: row?.error ?? null,
            changedBy: people.find(actor => actor.id === row?.changedBy)?.name ?? null, changedAt: row?.updatedAt.toISOString() ?? null };
        })} />
      : <HermesAdmin users={people} connections={connections} profiles={profiles} botNames={Object.fromEntries(definitions.map(({ id, name }) => [id, name]))}
          templates={apps.filter((a) => a.providerConfig.managed !== undefined).map(({ id, name, providerConfig }) => {
            const managed = providerConfig.managed as { provider?: unknown; model?: unknown };
            return { id, name, approvedBotId: typeof providerConfig.managedBotId === "string" ? providerConfig.managedBotId : null,
              provider: typeof managed?.provider === "string" ? managed.provider : null, model: typeof managed?.model === "string" ? managed.model : null,
              candidates: definitions.filter((b) => b.appId === id).map(({ id, name }) => ({ id, name })) };
          })} />}
  </div>;
}
