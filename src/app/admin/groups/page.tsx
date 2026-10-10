import { GroupsAdmin } from "@/components/admin/groups-admin";
import { AdminHeader } from "@/components/admin/ui";
import { db } from "@/db";
import { groupMappings, groupMembers, groups, users } from "@/db/schema";
import { knownExternalGroups } from "@/lib/auth/groups";
import { ldapEnabled } from "@/lib/auth/config";

export default async function AdminGroupsPage() {
  const [groupRows, mappings, known, members, userRows] = await Promise.all([
    db.select().from(groups).orderBy(groups.name),
    db.select().from(groupMappings),
    knownExternalGroups(),
    db.select().from(groupMembers),
    db.select({ id: users.id, name: users.name, email: users.email, upn: users.upn, disabled: users.disabled }).from(users).orderBy(users.name),
  ]);
  return (
    <div>
      <AdminHeader
        title="Groups"
        description="Add individual users or map directory groups to control connection and bot access, bot creation, and admin rights."
      />
      <GroupsAdmin
        ldapEnabled={ldapEnabled()}
        users={userRows}
        known={known.map((k) => ({ source: k.source, externalId: k.externalId, displayName: k.displayName }))}
        groups={groupRows.map((g) => ({
          id: g.id,
          name: g.name,
          description: g.description,
          isAdmin: g.isAdmin,
          canCreateBots: g.canCreateBots,
          memberIds: members.filter(m => m.groupId === g.id).map(m => m.userId),
          mappings: mappings
            .filter((m) => m.groupId === g.id)
            .map((m) => ({ source: m.source, externalId: m.externalId, displayName: m.displayName })),
        }))}
      />
    </div>
  );
}
