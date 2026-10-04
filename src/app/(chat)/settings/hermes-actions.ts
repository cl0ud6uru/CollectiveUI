'use server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { bots } from '@/db/schema';
import { revalidatePath } from 'next/cache';
import { requirePrincipal } from '@/lib/session';
import { dockerControl } from '@/lib/docker-hermes/client';
import { dockerStatus, freshDocker, pairDockerBot, withDockerAccess } from '@/lib/docker-hermes/store';
import type { DockerBinding } from '@/docker-hermes/types';
export async function personalHermesStatus() {
  const p = await requirePrincipal(); const state = await dockerStatus(p);
  if (state.phase !== 'ready') return state;
  const paired = state.bindings.length ? await db.select({ id: bots.id, name: bots.name }).from(bots).where(and(eq(bots.ownerId, p.user.id), inArray(bots.id, state.bindings.map(b => b.botId)))) : [];
  const bindings = state.bindings.filter(b => paired.some(row => row.id === b.botId)).map(b => ({ ...b, name: paired.find(row => row.id === b.botId)!.name }));
  return { ...state, bindings, phase: bindings.length === state.bindings.length ? state.phase : 'pairing' as const };
}
export async function enablePersonalHermes() {
  const p = await requirePrincipal();
  return withDockerAccess(p, true, async () => {
    await dockerControl(p.user.id, '/control/lease', { canCreate: true });
    return dockerControl(p.user.id, '/control/enable', {});
  });
}
export async function stopPersonalHermes() {
  const p = await requirePrincipal(); await freshDocker(p);
  return dockerControl(p.user.id, '/control/stop', {});
}
/** Polling is read-only. This explicit idempotent completion step publishes durable broker bindings. */
export async function finishPersonalHermes() {
  const p = await requirePrincipal(); await freshDocker(p, true);
  const state = await dockerStatus(p);
  if (state.phase !== 'ready') return;
  for (const b of state.bindings) await pairDockerBot(p, b);
  revalidatePath('/', 'layout');
}
export async function createPersonalHermesBot(input: { name: string; requestId: string }) {
  const p = await requirePrincipal(); await freshDocker(p, true);
  const b = await withDockerAccess(p, true, () => dockerControl<DockerBinding>(p.user.id, '/control/create', input));
  const id = await pairDockerBot(p, b); revalidatePath('/', 'layout'); return { id };
}
export async function linkPersonalHermesBot(input: { name: string; profile: string; identity: string }) {
  const p = await requirePrincipal(); await freshDocker(p, true);
  const b = await withDockerAccess(p, true, () => dockerControl<DockerBinding>(p.user.id, '/control/link', input));
  const id = await pairDockerBot(p, b); revalidatePath('/', 'layout'); return { id };
}
