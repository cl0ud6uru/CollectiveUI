import { WorkspaceTemplateCatalog } from "@/components/admin/workspace-template-catalog";
import { listAdminWorkspaceTemplates } from "@/lib/workspaces/catalog";
import { listWorkspaceCatalogProfileOptions } from "@/lib/workspaces/catalog-policy";
import { requireAdminPage } from "@/lib/session";

export default async function AdminWorkspaceTemplatesPage() {
  const principal = await requireAdminPage();
  const templates = await listAdminWorkspaceTemplates(principal);
  const profiles = listWorkspaceCatalogProfileOptions();
  return <WorkspaceTemplateCatalog templates={templates} profiles={profiles} />;
}
