import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { bots, hermesTeamOperations, hermesTeamProfiles } from '@/db/schema';
import type { Principal } from '@/lib/auth/groups';
import { HttpError } from '@/lib/authz';
import { authorizeTeam, reserveTeamProfile } from './store';
import { ensureTeamRuntime } from './transport';
import { teamNativeAvailability } from './candidate-availability';
import type { VerifiedTeamModelRoute } from './model-policy';
import type { TeamMode } from './types';
const binding = z.object({ bindingId: z.string().regex(/^[a-f0-9]{32}$/), ownerId: z.string(), botId: z.string(), appId: z.string(), runtimeId: z.string(), profile: z.string().regex(/^cui-team-[a-f0-9]{32}$/), identity: z.string().min(1), name: z.string(), purpose: z.enum(['team-member','team-admin']), teamBotId: z.string(), modelPolicy: z.enum(['admin_provided','admin_default_personal_allowed','personal_required']) }).strict();
const immutableIdentity = (native: z.infer<typeof binding>) => JSON.stringify([native.bindingId, native.ownerId, native.botId, native.appId, native.runtimeId, native.profile, native.identity, native.purpose, native.teamBotId]);
export async function ensureTeamPrivateInstance(p: Principal, botId: string, mode: TeamMode,dependencies:{conversationId?:string;routes?:readonly VerifiedTeamModelRoute[]}={}) {
  const profile = await reserveTeamProfile(p, botId, mode);
  const auth = await authorizeTeam(p, botId, mode);
  // Reopen always renews/verifies the current broker grant. A retained DB mapping
  // cannot prove that an expired lease or restarted broker is ready.
  try {
    const native = binding.parse(await ensureTeamRuntime(p, botId, mode));
    if (native.ownerId !== profile.ownerKey || native.botId !== botId || native.teamBotId !== botId || native.purpose !== `team-${mode}` || native.modelPolicy !== auth.definition.modelPolicy.mode)
      throw new HttpError(409, 'The retained Team runtime mapping needs reconciliation.');
    return await db.transaction(async tx => {
      // Configuration and provisioning take locks in the same order. Otherwise a
      // settings change could commit after the freshness check but before binding.
      await tx.select({ id: bots.id }).from(bots).where(eq(bots.id, botId)).for('update');
      const current = await authorizeTeam(p, botId, mode, tx);
      if (current.definition.version !== auth.definition.version) throw new HttpError(409, 'Team configuration changed during setup. Reopen the bot.');
      const [previous] = await tx.select().from(hermesTeamProfiles).where(eq(hermesTeamProfiles.id, profile.id)).for('update');
      if (previous.binding && immutableIdentity(binding.parse(previous.binding)) !== immutableIdentity(native)) throw new HttpError(409, 'The retained native mapping changed. No profile was reassigned.');
      // Current native route proof is required; login/configuration alone cannot make this ready.
      const [pending] = await tx.select({ state: hermesTeamOperations.state }).from(hermesTeamOperations)
        .where(and(eq(hermesTeamOperations.profileId, profile.id), inArray(hermesTeamOperations.state, ['pending', 'needs_attention']))).limit(1);
      // Reopening must retain recovery fencing even when a native plan has not begun yet.
      const model=pending?null:await teamNativeAvailability(p,botId,mode,{q:tx,routes:dependencies.routes,conversationId:dependencies.conversationId,preparedProfile:{...previous,binding:native,state:'connection_needed'}});
      const state = pending ? pending.state === 'needs_attention' || previous.state === 'needs_attention' ? 'needs_attention' : 'updating' : model && !model.available && model.needsAttention?'needs_attention':model?.available?'ready':'connection_needed';
      const [ready] = await tx.update(hermesTeamProfiles).set({ binding: native, state, updatedAt: new Date() }).where(eq(hermesTeamProfiles.id, profile.id)).returning();
      return ready;
    });
  } catch (e) {
    if (e instanceof HttpError && [403,404].includes(e.status)) throw e;
    await authorizeTeam(p, botId, mode);
    const [attention] = await db.update(hermesTeamProfiles).set({ state: 'needs_attention', updatedAt: new Date() }).where(eq(hermesTeamProfiles.id, profile.id)).returning();
    return attention;
  }
}
