import { notFound } from 'next/navigation';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { remoteHermesSessions } from '@/db/schema';
import { PageFrame } from '@/components/page-frame';
import { NativeWorkspace } from '@/components/hermes/native-workspace';
import { requirePagePrincipal } from '@/lib/session';
import { getSetting } from '@/lib/settings';
import { listRemoteConnections, remoteProfiles } from '@/lib/remote-hermes/store';

export default async function HermesPage({ params, searchParams }: PageProps<'/hermes/[connectionId]'>) {
  const principal = await requirePagePrincipal();
  const { connectionId } = await params;
  const connection = (await listRemoteConnections(principal.user.id)).find(c => c.id === connectionId);
  if (!connection) notFound();
  const policy = await getSetting('remoteHermes');
  let profiles: Awaited<ReturnType<typeof remoteProfiles>> = [];
  let error = '';
  if (policy.enabled) {
    try { profiles = await remoteProfiles(principal.user.id, connectionId); }
    catch (e) { error = e instanceof Error ? e.message : 'Could not load Hermes profiles.'; }
  }
  const saved = await db.select({ id: remoteHermesSessions.id, storedId: remoteHermesSessions.storedId, title: remoteHermesSessions.title, profile: remoteHermesSessions.profile, status: remoteHermesSessions.status })
    .from(remoteHermesSessions).where(and(eq(remoteHermesSessions.connectionId, connectionId))).orderBy(desc(remoteHermesSessions.updatedAt)).limit(100);
  const query = await searchParams;
  const selected = typeof query.session === 'string' && saved.some(s => s.id === query.session) ? query.session : null;
  return <PageFrame title={connection.name}><NativeWorkspace connectionId={connectionId} profiles={profiles} saved={saved} allowed={policy.enabled} initialSession={selected} initialError={error} /></PageFrame>;
}
