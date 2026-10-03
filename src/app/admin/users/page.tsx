import Link from "next/link";
import { CreateLocalUser, ResetLocalPassword } from "@/components/admin/local-users";
import { localEnabled } from "@/lib/auth/config";
import { requireAdminPage } from "@/lib/session";
import { desc, ilike, or, sql } from "drizzle-orm";
import { UserRowActions } from "@/components/admin/row-actions";
import { AdminHeader, Badge, Table, Td } from "@/components/admin/ui";
import { db } from "@/db";
import { users } from "@/db/schema";
import { resolvePrincipal } from "@/lib/auth/groups";

export default async function AdminUsersPage(props: PageProps<"/admin/users">) {
  const principal = await requireAdminPage();
  const sp = await props.searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const rows = await db
    .select({
      user: users,
      groupCount: sql<number>`(select count(*)::int from user_external_groups g where g.user_id = ${users.id})`,
      chats: sql<number>`(select count(*)::int from conversations c where c.user_id = ${users.id})`,
    })
    .from(users)
    .where(q ? or(ilike(users.name, `%${q}%`), ilike(users.upn, `%${q}%`)) : undefined)
    .orderBy(desc(users.lastLoginAt))
    .limit(200);
  const principals = await Promise.all(rows.map((r) => resolvePrincipal(r.user)));

  return (
    <div>
      <AdminHeader title="Users" description="Manage local accounts and directory users. Directory users appear after their first sign-in." />
      {localEnabled() && <CreateLocalUser />}
      {principal.user.identityRealm === "local" && <Link href="/account/password" className="mb-4 block text-sm underline">Change my password</Link>}
      <form className="mb-4">
        <input
          name="q"
          defaultValue={q}
          placeholder="Search by name or UPN…"
          className="h-10 w-full max-w-sm rounded-lg border border-border bg-transparent px-3 text-sm outline-none"
        />
      </form>
      <Table head={["User", "Sign-in", "Directory groups", "Chats", "Last login", "Role", ""]}>
        {rows.map(({ user, groupCount, chats }, i) => {
          const p = principals[i];
          return (
            <tr key={user.id}>
              <Td>
                <div className="font-medium">{user.name}</div>
                <div className="text-xs text-muted">{user.upn}</div>
              </Td>
              <Td>
                <Badge tone={user.authSource === "entra" ? "blue" : "amber"}>{user.authSource === "entra" ? "Entra" : user.authSource === "local" ? "Local" : "LDAP"}</Badge>
              </Td>
              <Td className="tabular-nums">{groupCount}</Td>
              <Td className="tabular-nums">{chats}</Td>
              <Td className="text-xs text-muted">{user.lastLoginAt?.toLocaleString() ?? "—"}</Td>
              <Td className="space-x-1">
                {p.isAdmin && <Badge tone="red">{user.isAdmin ? "admin" : "admin (group)"}</Badge>}
                {user.disabled && <Badge>disabled</Badge>}
              </Td>
              <Td>
                <UserRowActions userId={user.id} isAdmin={user.isAdmin} disabled={user.disabled} />
                {localEnabled() && user.authSource === "local" && user.id !== principal.user.id && <ResetLocalPassword userId={user.id} />}
              </Td>
            </tr>
          );
        })}
      </Table>
    </div>
  );
}
