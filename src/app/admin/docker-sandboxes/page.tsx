import { AdminHeader } from '@/components/admin/ui';
import { DockerSandboxesAdmin } from '@/components/admin/docker-sandboxes-admin';
import { readDockerSandboxes } from './actions';
import { requireAdminPage } from '@/lib/session';

export default async function DockerSandboxesAdminPage() {
  await requireAdminPage();
  const data = await readDockerSandboxes();
  return <div>
    <AdminHeader title="Docker Sandboxes" description="Manage the optional personal Codex SBX runtime. Host actions are available only when the operator-enabled broker is ready." />
    <DockerSandboxesAdmin initialData={data} />
  </div>;
}
