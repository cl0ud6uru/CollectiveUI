import { eq } from "drizzle-orm";
import { db } from "@/db";
import { aiApps, bots } from "@/db/schema";
import { isDockerHermes } from "./policy";
import { loadPrincipal } from '@/lib/auth/groups';
import { getSetting } from '@/lib/settings';
import { dockerControl } from './client';
import { assertDockerCreate, dockerAllowed } from './policy';
import { pairDockerBot } from './store';
import type { DockerStatus } from '@/docker-hermes/types';
/** Trusted worker only. Missing/deleted/revoked owners receive stop, never fresh read/chat authority. */
export async function reconcileDockerRuntimes() {
  if (!process.env.DOCKER_HERMES_SOCKET) return;
  const owners = await dockerControl<string[]>('worker', '/admin/owners');
  for (const owner of owners) {
    const p = await loadPrincipal(owner);
    if (!p || !dockerAllowed(p)) { await dockerControl(owner, '/control/stop', {}); continue; }
    const assigned = await db.select({ bot: bots, app: aiApps }).from(bots).innerJoin(aiApps, eq(aiApps.id, bots.appId)).where(eq(bots.ownerId, owner));
    if (assigned.some(({ bot, app }) => isDockerHermes(app) && (!bot.enabled || !app.enabled || bot.visibility !== 'private' || bot.executionMode !== 'caller' || bot.coordinatorEligible))) {
      await dockerControl(owner, '/control/stop', {}); continue;
    }
    let canCreate = true;
    try { assertDockerCreate(p, await getSetting('tools')); } catch { canCreate = false; }
    await dockerControl(owner, '/control/lease', { canCreate });
    const status = await dockerControl<DockerStatus>(owner, '/control/status');
    if (canCreate && status.phase === 'ready') for (const b of status.bindings) await pairDockerBot(p, b);
  }
}
