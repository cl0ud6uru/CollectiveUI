import Link from 'next/link';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { remoteHermesConnections, remoteHermesSessions } from '@/db/schema';
import { PageFrame } from '@/components/page-frame';
import { requirePagePrincipal } from '@/lib/session';
import { getSetting } from '@/lib/settings';
import { listRemoteConnections } from '@/lib/remote-hermes/store';

export default async function HermesHome() {
  const principal = await requirePagePrincipal();
  const [connections, policy, recent] = await Promise.all([
    listRemoteConnections(principal.user.id), getSetting('remoteHermes'),
    db.select({ id: remoteHermesSessions.id, title: remoteHermesSessions.title, profile: remoteHermesSessions.profile, connectionId: remoteHermesConnections.id, connectionName: remoteHermesConnections.name, status: remoteHermesSessions.status })
      .from(remoteHermesSessions).innerJoin(remoteHermesConnections, eq(remoteHermesConnections.id, remoteHermesSessions.connectionId))
      .where(and(eq(remoteHermesConnections.userId, principal.user.id))).orderBy(desc(remoteHermesSessions.updatedAt)).limit(30),
  ]);
  return <PageFrame title="Hermes"><div className="space-y-6">
    {!policy.enabled && <p role="status" className="text-sm text-muted">Personal remote Hermes is disabled. Your active chats can still finish, receive answers and be stopped.</p>}
    <section aria-label="Hermes connections" className="space-y-2"><h2 className="font-medium">Your connections</h2>
      {connections.map(c => <Link key={c.id} href={`/hermes/${encodeURIComponent(c.id)}`} className="block rounded-xl border border-border p-4 hover:bg-hover">{c.name}<span className="block text-sm text-muted">Choose a profile and open a chat</span></Link>)}
      {!connections.length && <p className="text-sm text-muted">Connect your Hermes server to browse its profiles and conversations.</p>}
      <Link href="/settings" className="inline-block text-sm underline">Manage Hermes connections</Link>
    </section>
    <section aria-label="Recent Hermes chats" className="space-y-2"><h2 className="font-medium">Recent chats</h2>
      {recent.map(s => <Link key={s.id} href={`/hermes/${encodeURIComponent(s.connectionId)}?session=${encodeURIComponent(s.id)}`} className="block rounded-lg border border-border p-3 hover:bg-hover">{s.title}<span className="block text-xs text-muted">{s.connectionName} · {s.profile}{s.status !== 'idle' ? ' · In progress' : ''}</span></Link>)}
      {!recent.length && <p className="text-sm text-muted">Chats you open appear here.</p>}
    </section>
  </div></PageFrame>;
}
