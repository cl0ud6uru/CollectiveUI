import Link from "next/link";
import { CreateLocalUser, ResetLocalPassword } from "@/components/admin/local-users";
import { localEnabled } from "@/lib/auth/config";
import { requireAdminPage } from "@/lib/session";
import { UserRowActions } from "@/components/admin/row-actions";
import { AdminHeader, Badge, Table, Td } from "@/components/admin/ui";
import { AdminPagination } from "@/components/admin/pagination";
import { AdminTimestamp } from "@/components/admin/timestamp";
import { listAdminUsers } from "@/lib/admin/users";
import { queryText, requestedPage } from "@/lib/admin/listing";
import { resolvePrincipal } from "@/lib/auth/groups";

export default async function AdminUsersPage(props: PageProps<"/admin/users">) {
  const principal = await requireAdminPage();
  const sp = await props.searchParams;
  const q = queryText(sp.q);
  const { rows, window } = await listAdminUsers(principal, q, requestedPage(sp.page));
  const principals = await Promise.all(rows.map((r) => resolvePrincipal(r.user)));

  return (
    <div>
      <AdminHeader title="Users" description="Manage local accounts and directory users. Directory users appear after their first sign-in." />
      {localEnabled() && <CreateLocalUser />}
      {principal.user.identityRealm === "local" && <Link href="/account/password" className="mb-4 block text-sm underline">Change my password</Link>}
      <form className="mb-4 flex flex-wrap items-end gap-2" action="/admin/users">
        <label htmlFor="user-search" className="w-full text-sm font-medium">Search users</label>
        <input
          id="user-search"
          name="q"
          defaultValue={q}
          placeholder="Search by name or UPN…"
          className="h-10 w-full max-w-sm rounded-lg border border-border bg-transparent px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
        />
        <button className="h-10 rounded-lg border border-border px-4 text-sm hover:bg-hover" type="submit">Search</button>
        {q && <Link href="/admin/users" className="px-2 py-2 text-sm underline">Clear search</Link>}
      </form>
      <AdminPagination window={window} path="/admin/users" filters={{ q }} noun="users" />
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
              <Td className="text-xs text-muted"><AdminTimestamp value={user.lastLoginAt} /></Td>
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
        {!rows.length && <tr><Td colSpan={7} className="py-8 text-center text-muted">
          {q ? <>No users match “{q}”. <Link href="/admin/users" className="underline">Clear search</Link></> : "No users yet."}
        </Td></tr>}
      </Table>
      {window.pages > 1 && <AdminPagination window={window} path="/admin/users" filters={{ q }} noun="users" />}
    </div>
  );
}
