import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/db";
import { bots, users } from "@/db/schema";
import { loadPrincipal, type Principal } from "@/lib/auth/groups";
import { assertAdmin, HttpError } from "@/lib/authz";
import { audit, auditVia, type AuditVia } from "@/lib/audit";

export const BotStatusInput = z.object({ botId: z.string().min(1).max(128), enabled: z.boolean(), expectedRevision: z.number().int().min(1).optional() }).strict();
type Input = z.input<typeof BotStatusInput>;

/** Shared Admin UI/Architect API. Authorization, mutation, read-back and audit commit together. */
export async function changeBotStatus(actor: Principal, raw: Input, options: {
  via?: AuditVia;
  signal?: AbortSignal;
  beforeWrite?: (tx: Tx) => Promise<void>;
} = {}) {
  assertAdmin(actor);
  const input = BotStatusInput.parse(raw);
  if (options.via && input.expectedRevision === undefined) throw new HttpError(400, "Read the bot revision before requesting approval.");
  let teamChanged = false;
  const result = await db.transaction(async tx => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, actor.user.id)).for("share");
    const fresh = await loadPrincipal(actor.user.id, tx);
    if (!fresh || fresh.user.sessionVersion !== actor.user.sessionVersion) throw new HttpError(403, "Your access changed. Sign in again.");
    assertAdmin(fresh);
    await options.beforeWrite?.(tx);
    options.signal?.throwIfAborted();
    const [bot] = await tx.select().from(bots).where(eq(bots.id, input.botId)).for("update");
    if (!bot) throw new HttpError(404, "Bot not found.");
    if (input.expectedRevision !== undefined && bot.revision !== input.expectedRevision)
      throw new HttpError(409, "Bot configuration changed. Read it again and request fresh approval.");
    // Team administration has its own lifecycle. The ordinary Admin UI retains that path.
    if (bot.hermesTeam) {
      if (options.via) throw new HttpError(400, "Manage team bots in Admin → Bots.");
      teamChanged = true;
      const { authorizeTeam } = await import("@/lib/hermes-team/store");
      await authorizeTeam(fresh, bot.id, "admin", tx, true);
    }
    options.signal?.throwIfAborted();
    await tx.update(bots).set({ enabled: input.enabled, revision: sql`${bots.revision} + 1`, publishedRevision: null, publishedConfigHash: null }).where(eq(bots.id, bot.id));
    if (teamChanged) {
      const { queueTeamAccessReconciliation } = await import("@/lib/hermes-team/revocation");
      await queueTeamAccessReconciliation(tx, bot.id, fresh.user.id, { reason: "bot_disabled" });
    }
    const [saved] = await tx.select({ id: bots.id, enabled: bots.enabled, revision: bots.revision }).from(bots).where(eq(bots.id, bot.id));
    if (!saved || saved.enabled !== input.enabled || saved.revision !== bot.revision + 1)
      throw new HttpError(409, "Bot change could not be verified.");
    const action = input.enabled ? "bot.enable" : "bot.disable";
    const details = { previousEnabled: bot.enabled, enabled: saved.enabled, revision: saved.revision };
    if (options.via) await auditVia(fresh.user.id, options.via, action, bot.id, details, tx);
    else await audit(fresh.user.id, action, bot.id, details, tx);
    return { status: "verified" as const, bot: saved };
  });
  if (teamChanged) {
    const { reconcileTeamAccess } = await import("@/lib/hermes-team/revocation");
    await reconcileTeamAccess(input.botId);
  }
  return result;
}
