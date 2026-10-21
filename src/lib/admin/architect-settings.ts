import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/db";
import { settings } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { HttpError } from "@/lib/authz";
import { auditVia } from "@/lib/audit";
import { lockArchitectActor, authorizeArchitectCall } from "@/lib/agent/tools/admin-guard";
import type { AgentCtx } from "@/lib/agent/types";
import { BrandingInput } from "@/lib/branding/shared";
import { effectiveUploadMaxMb, MAX_UPLOAD_MB, uploadMaxMbInput } from "@/lib/files/upload-limits";
import { getSetting, type BrandingSettings, type LimitsSettings } from "@/lib/settings";

const timestamp = z.string().datetime({ offset: true }).nullable();
const brandingPatch = z.object({
  setting: z.literal("branding"), expectedUpdatedAt: timestamp,
  appName: z.string().trim().min(1).max(60).optional(), welcomeText: z.string().trim().max(200).optional(),
  logoEmoji: z.string().trim().max(32).optional(), loginHeadline: z.string().trim().max(100).optional(),
  loginDescription: z.string().trim().max(240).optional(),
}).strict().refine(input => [input.appName, input.welcomeText, input.logoEmoji, input.loginHeadline, input.loginDescription].some(value => value !== undefined),
  "Choose a public branding field to update.");
const limitsUpdate = z.object({
  setting: z.literal("limits"), expectedUpdatedAt: timestamp,
  uploadMaxMb: uploadMaxMbInput, maxAttachmentsPerMessage: z.number().int().min(1).max(50),
}).strict();
export const architectSettingsUpdateInput = z.discriminatedUnion("setting", [brandingPatch, limitsUpdate]);

const timestampToken = () => sql<string>`to_char(${settings.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

async function prepareWrite(ctx: AgentCtx, tx: Tx): Promise<Principal> {
  await lockArchitectActor(ctx, tx);
  const fresh = await authorizeArchitectCall(ctx, tx);
  if (!fresh.isAdmin) throw new HttpError(403, "Admin tools are for administrators only.");
  return fresh;
}

export async function adminGetArchitectSettings(p: Principal) {
  if (!p.isAdmin) throw new HttpError(403, "Admin only");
  return db.transaction(async tx => {
    // Read values and their CAS tokens from one repeatable-read snapshot. Separate pool queries could
    // pair stale values with a newer revision if an Admin save lands between them.
    const rows = await tx.select({ key: settings.key, updatedAt: timestampToken() })
      .from(settings).where(sql`${settings.key} in ('branding', 'limits')`);
    const byKey = new Map(rows.map(row => [row.key, row]));
    const branding = await getSetting("branding", tx);
    const limits = await getSetting("limits", tx);
    return {
      branding: {
        appName: branding.appName, welcomeText: branding.welcomeText, logoEmoji: branding.logoEmoji,
        loginHeadline: branding.loginHeadline, loginDescription: branding.loginDescription,
      },
      brandingUpdatedAt: byKey.get("branding")?.updatedAt ?? null,
      limits: { uploadMaxMb: limits.uploadMaxMb, maxAttachmentsPerMessage: limits.maxAttachmentsPerMessage },
      limitsUpdatedAt: byKey.get("limits")?.updatedAt ?? null,
      uploadPolicy: {
        maximumFileMb: MAX_UPLOAD_MB, effectiveFileMb: effectiveUploadMaxMb(limits.uploadMaxMb),
        ...(limits.uploadMaxMb > MAX_UPLOAD_MB ? { notice: `The saved ${limits.uploadMaxMb} MB limit exceeds the supported ${MAX_UPLOAD_MB} MB maximum. Its saved value is unchanged; uploads use ${MAX_UPLOAD_MB} MB until an admin saves a supported limit.` } : {}),
      },
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export async function updateArchitectSettings(ctx: AgentCtx, _actor: Principal, raw: unknown, signal?: AbortSignal) {
  const input = architectSettingsUpdateInput.parse(raw);
  return db.transaction(async tx => {
    const fresh = await prepareWrite(ctx, tx);
    const [row] = await tx.select().from(settings).where(eq(settings.key, input.setting)).for("update");
    const token = row ? (await tx.select({ updatedAt: timestampToken() }).from(settings).where(eq(settings.key, input.setting)))[0]?.updatedAt ?? null : null;
    if (token !== input.expectedUpdatedAt) throw new HttpError(409, "Settings changed. Read them again and request fresh approval.");

    let next: BrandingSettings | LimitsSettings;
    if (input.setting === "branding") {
      const current = await getSetting("branding", tx);
      // The Architect can edit public copy only. Default model/bot routing remains untouched.
      next = BrandingInput.parse({ ...current, ...input }) as BrandingSettings;
    } else {
      next = { uploadMaxMb: input.uploadMaxMb, maxAttachmentsPerMessage: input.maxAttachmentsPerMessage };
    }

    signal?.throwIfAborted();
    if (row) {
      const [saved] = await tx.update(settings).set({ value: next, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(settings.key, input.setting), sql`${settings.updatedAt} = ${token}::timestamptz`)).returning();
      if (!saved) throw new HttpError(409, "Settings changed. Read them again and request fresh approval.");
    } else {
      const [saved] = await tx.insert(settings).values({ key: input.setting, value: next }).onConflictDoNothing().returning();
      if (!saved) throw new HttpError(409, "Settings changed. Read them again and request fresh approval.");
    }
    const [readback] = await tx.select().from(settings).where(eq(settings.key, input.setting));
    const savedValue = readback?.value as Record<string, unknown> | undefined;
    const matches = input.setting === "branding"
      ? !!savedValue && (next as BrandingSettings).appName === savedValue.appName && (next as BrandingSettings).welcomeText === savedValue.welcomeText &&
        (next as BrandingSettings).logoEmoji === savedValue.logoEmoji && (next as BrandingSettings).loginHeadline === savedValue.loginHeadline &&
        (next as BrandingSettings).loginDescription === savedValue.loginDescription && (next as BrandingSettings).defaultAppId === savedValue.defaultAppId &&
        (next as BrandingSettings).defaultBotId === savedValue.defaultBotId
      : !!savedValue && (next as LimitsSettings).uploadMaxMb === savedValue.uploadMaxMb &&
        (next as LimitsSettings).maxAttachmentsPerMessage === savedValue.maxAttachmentsPerMessage;
    if (!readback || !matches) throw new HttpError(409, "Settings update could not be verified.");
    signal?.throwIfAborted();
    await auditVia(fresh.user.id, { agent: "architect", botId: ctx.bot!.id }, `architect.settings.${input.setting}.update`, input.setting,
      input.setting === "branding" ? { fields: Object.keys(input).filter(key => key !== "setting" && key !== "expectedUpdatedAt") } : next, tx);
    signal?.throwIfAborted();
    const updatedAt = (await tx.select({ updatedAt: timestampToken() }).from(settings).where(eq(settings.key, input.setting)))[0]?.updatedAt;
    return { status: "verified" as const, setting: input.setting, updatedAt, value: input.setting === "branding"
      ? { appName: (next as BrandingSettings).appName, welcomeText: (next as BrandingSettings).welcomeText,
        logoEmoji: (next as BrandingSettings).logoEmoji, loginHeadline: (next as BrandingSettings).loginHeadline,
        loginDescription: (next as BrandingSettings).loginDescription }
      : next };
  });
}
