import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageFrame } from '@/components/page-frame';
import { NativeOperations } from '@/components/hermes/native-operations';
import { requirePagePrincipal } from '@/lib/session';
import { listRemoteConnections, remoteProfiles } from '@/lib/remote-hermes/store';
import { getSetting } from '@/lib/settings';

export default async function OperationsPage({ params }: { params: Promise<{ connectionId: string }> }) {
  const principal = await requirePagePrincipal();
  const { connectionId } = await params;
  const connection = (await listRemoteConnections(principal.user.id)).find(c => c.id === connectionId);
  if (!connection) notFound();
  const policy = await getSetting('remoteHermes');
  let profiles: Awaited<ReturnType<typeof remoteProfiles>> = [];
  let unavailable = false;
  if (policy.enabled) { try { profiles = await remoteProfiles(principal.user.id, connectionId); } catch { unavailable = true; } }
  return <PageFrame title={`${connection.name} · Workspace`}><div className="space-y-4">
    <Link className="text-sm underline" href={`/hermes/${connectionId}`}>Back to Hermes chats</Link>
    <p className="text-sm text-muted-foreground">Browse this connected Hermes dashboard’s projects, directory names, schedules, plugins and resource usage. Profiles select projects and schedules within your dashboard account; plugins and system resources describe the shared Hermes instance.</p>
    {policy.enabled ? unavailable ? <p role="alert">Could not load Hermes profiles. Check your connection in Settings and reload this page.</p> : <NativeOperations connectionId={connectionId} profiles={profiles} /> : <p>Personal remote Hermes access is disabled. Your saved connections are retained.</p>}
  </div></PageFrame>;
}
