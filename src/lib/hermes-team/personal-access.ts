import { and, eq } from 'drizzle-orm';
import { db, type DbOrTx } from '@/db';
import { userCredentials } from '@/db/schema';
import { loadPrincipal, type Principal } from '@/lib/auth/groups';
import { officialPlanMetadata } from './official-plan';
import type { TeamModelIntegration, TeamPersonalModelConnection } from './model-policy';

/** Metadata only: no decryption, refresh, OAuth grant or native profile credential lookup. */
export async function loadTeamPersonalAccess(p: Principal, integration: TeamModelIntegration, q: DbOrTx = db, now = Date.now()): Promise<TeamPersonalModelConnection | null> {
  // The application connection uses Codex device authentication/backend. It is not the newer official plan integration.
  if(!['hermes_native_codex','openai_chatgpt_plan_usage'].includes(integration))return null;
  const fresh = await loadPrincipal(p.user.id, q);
  if (!fresh || fresh.user.sessionVersion !== p.user.sessionVersion) return null;
  if(integration==='openai_chatgpt_plan_usage'){try{const row=await officialPlanMetadata(fresh.user.id,undefined,q,now);return row?{id:row.id,userId:row.userId,integration,status:'active',expiresAt:row.expiresAt}:null;}catch{return null;}}
  const [row] = await q.select({ id: userCredentials.id, userId: userCredentials.userId,
    status: userCredentials.status, expiresAt: userCredentials.expiresAt }).from(userCredentials)
    .where(and(eq(userCredentials.userId, fresh.user.id), eq(userCredentials.provider, 'chatgpt')));
  if (!row) return null;
  const expiresAt = row.expiresAt?.getTime() ?? 0;
  return { id: row.id, userId: row.userId, integration:'hermes_native_codex', expiresAt,
    status: row.status === 'active' && expiresAt > now ? 'active' : 'expired' };
}
