'use server';
import { headers } from 'next/headers';
import { requirePrincipal } from '@/lib/session';
import { assertAuthOrigin } from '@/lib/auth/origin';
import { connectRemoteHermes, remoteProfiles, type RemoteConnectionInput } from '@/lib/remote-hermes/store';
import { audit } from '@/lib/audit';

export async function signIntoRemoteHermes(input: RemoteConnectionInput) {
  const p = await requirePrincipal();
  assertAuthOrigin(new Headers(await headers()));
  const result = await connectRemoteHermes(p.user.id, input);
  await audit(p.user.id, 'hermes.remote.connected', result.connection.id, { authMode: result.connection.authMode });
  return result;
}
export async function loadRemoteHermesProfiles(connectionId: string) {
  const p = await requirePrincipal();
  return remoteProfiles(p.user.id, connectionId);
}
