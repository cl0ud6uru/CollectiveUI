import { GroupsAdmin } from "@/components/admin/groups-admin";
import { AdminHeader } from "@/components/admin/ui";
import { db } from "@/db";
import { groupMappings, groups } from "@/db/schema";
import { knownExternalGroups } from "@/lib/auth/groups";

export default async function AdminGroupsPage() {
  const [groupRows, mappings, known] = await Promise.all([
    db.select().from(groups).orderBy(groups.name),
    db.select().from(groupMappings),
    knownExternalGroups(),
  ]);
  return (
    <div>
      <AdminHeader
        title="Groups"
        description="Portal groups map to Active Directory groups (Entra object IDs and/or on-prem LDAP DNs). They control connection & bot access and admin rights."
      />
      <GroupsAdmin
        known={known.map((k) => ({ source: k.source, externalId: k.externalId, displayName: k.displayName }))}
        groups={groupRows.map((g) => ({
          id: g.id,
          name: g.name,
          description: g.description,
          isAdmin: g.isAdmin,
          canCreateBots: g.canCreateBots,
          mappings: mappings
            .filter((m) => m.groupId === g.id)
            .map((m) => ({ source: m.source, externalId: m.externalId, displayName: m.displayName })),
        }))}
      />
    </div>
  );
}
