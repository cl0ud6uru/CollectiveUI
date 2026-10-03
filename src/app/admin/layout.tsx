import { AdminNav } from "@/components/admin/admin-nav";
import { requireAdminPage } from "@/lib/session";
import { getSetting } from "@/lib/settings";

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  await requireAdminPage();
  const branding = await getSetting("branding");
  return (
    <div className="flex h-dvh flex-col md:flex-row">
      <AdminNav appName={branding.appName} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">{children}</div>
      </main>
    </div>
  );
}
