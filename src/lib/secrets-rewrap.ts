import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { liveActivities, aiApps, chatgptDeviceLogins, hermesConnections, mcpServers, routines, userTokens, providerConnections, settings } from "@/db/schema";
import { rewrapRemoteHermesSecrets } from "@/lib/remote-hermes/store";
import { connectionAAD } from "@/lib/hermes-provisioning/config";
import { AAD, encrypt, needsRewrap, rewrap } from "@/lib/crypto";
import { rewrapChatGPTSecrets } from "@/lib/llm/chatgpt/store";
import { appSecretNeedsRowBinding, openAppSecret, sealAppSecret } from "@/lib/llm/secrets";
import { providerConnectionAad } from "@/lib/llm/provider-connections";
import { getSetting } from "@/lib/settings";
import { rewrapMemberMcpSecrets } from "@/lib/mcp/member-connections";
import { rewrapBillingSecrets } from "@/lib/billing/secrets";
import { carryServicePublications } from "@/lib/bots/service";

/**
 * Re-encrypts every stored secret under the primary key (with AAD). Idempotent: values that are already
 * current are left alone. Runs at worker start so a key rotation only needs a new ENCRYPTION_PRIMARY_KID.
 * Also encrypts routine webhook secrets that were stored as plaintext before encryption was added.
 */
export async function rewrapAllSecrets(): Promise<number> {
  let changed = 0;
  changed += await rewrapBillingSecrets();
  for (const row of await db.select().from(liveActivities)) {
    const next = rewrap(row.tokenEnc, `live_activities.token_enc|${row.sessionId}|${row.activityId}`);
    if (next) {
      await db.update(liveActivities).set({ tokenEnc: next }).where(and(eq(liveActivities.sessionId, row.sessionId),
        eq(liveActivities.activityId, row.activityId), eq(liveActivities.tokenEnc, row.tokenEnc)));
      changed++;
    }
  }
  for (const row of await db.select().from(providerConnections)) {
    const next = rewrap(row.credentialEnc, providerConnectionAad(row.id));
    if (next) {
      await db.update(providerConnections).set({ credentialEnc: next }).where(and(eq(providerConnections.id, row.id), eq(providerConnections.credentialEnc, row.credentialEnc)));
      changed++;
    }
  }
  for (const row of await db.select().from(hermesConnections)) {
    const next = rewrap(row.credentialsEnc, connectionAAD(row.id));
    if (next) {
      await db.update(hermesConnections).set({ credentialsEnc: next }).where(and(eq(hermesConnections.id, row.id), eq(hermesConnections.credentialsEnc, row.credentialsEnc)));
      changed++;
    }
  }

  // Personal account credentials stay owned by their dedicated credential store.
  changed += await rewrapRemoteHermesSecrets();

  // App credentials are bound to their row (AAD "ai_apps.api_key_enc|<id>"); older values used the column only.
  for (const row of await db.select({ id: aiApps.id, apiKeyEnc: aiApps.apiKeyEnc }).from(aiApps).where(isNotNull(aiApps.apiKeyEnc))) {
    const moved = await db.transaction(async tx => {
      const [before] = await tx.select().from(aiApps).where(eq(aiApps.id, row.id)).for("update");
      if (!before?.apiKeyEnc || (!appSecretNeedsRowBinding(before) && !needsRewrap(before.apiKeyEnc))) return false;
      const [after] = await tx.update(aiApps).set({ apiKeyEnc: sealAppSecret(before.id, openAppSecret(before)!) })
        .where(eq(aiApps.id, before.id)).returning();
      // Only the ciphertext changes. Carry publications that were current under the same row lock; never bless drift.
      await carryServicePublications(tx, before, after);
      return true;
    });
    if (moved) changed++;
  }

  for (const row of await db.select({ id: mcpServers.id, v: mcpServers.headersEnc }).from(mcpServers).where(isNotNull(mcpServers.headersEnc))) {
    const next = rewrap(row.v!, AAD.mcpHeaders);
    if (next) {
      const moved = await db.update(mcpServers).set({ headersEnc: next })
        .where(and(eq(mcpServers.id, row.id), eq(mcpServers.headersEnc, row.v!))).returning({ id: mcpServers.id });
      changed += moved.length;
    }
  }

  // Identity secrets are bound to their server row.
  for (const row of await db.select({ id: mcpServers.id, v: mcpServers.identitySecretEnc }).from(mcpServers).where(isNotNull(mcpServers.identitySecretEnc))) {
    const next = rewrap(row.v!, `${AAD.mcpIdentitySecret}|${row.id}`);
    if (next) {
      // Only if it wasn't rotated meanwhile.
      await db
        .update(mcpServers)
        .set({ identitySecretEnc: next })
        .where(and(eq(mcpServers.id, row.id), eq(mcpServers.identitySecretEnc, row.v!)));
      changed++;
    }
  }

  for (const row of await db.select().from(userTokens)) {
    const access = rewrap(row.accessTokenEnc, AAD.userAccessToken);
    const refresh = row.refreshTokenEnc ? rewrap(row.refreshTokenEnc, AAD.userRefreshToken) : null;
    if (access || refresh) {
      // Access and refresh tokens form one snapshot. A refresh, revocation or new sign-in must win over
      // a stale startup scan, including when it installs the first refresh token on this row.
      const moved = await db
        .update(userTokens)
        .set({ ...(access ? { accessTokenEnc: access } : {}), ...(refresh ? { refreshTokenEnc: refresh } : {}) })
        .where(and(eq(userTokens.userId, row.userId), eq(userTokens.accessTokenEnc, row.accessTokenEnc),
          row.refreshTokenEnc === null ? isNull(userTokens.refreshTokenEnc) : eq(userTokens.refreshTokenEnc, row.refreshTokenEnc)))
        .returning({ id: userTokens.userId });
      changed += moved.length;
    }
  }

  for (const row of await db.select({ id: routines.id, v: routines.webhookSecret }).from(routines).where(isNotNull(routines.webhookSecret))) {
    const next = row.v!.startsWith("v2.") ? rewrap(row.v!, AAD.routineWebhookSecret) : encrypt(row.v!, AAD.routineWebhookSecret);
    if (next) {
      const moved = await db.update(routines).set({ webhookSecret: next })
        .where(and(eq(routines.id, row.id), eq(routines.webhookSecret, row.v!))).returning({ id: routines.id });
      changed += moved.length;
    }
  }

  // ChatGPT connections are rewrapped under their row lock (refresh tokens must never be written back stale).
  changed += await rewrapChatGPTSecrets();
  changed += await rewrapMemberMcpSecrets();
  for (const row of await db.select({ userId: chatgptDeviceLogins.userId, v: chatgptDeviceLogins.deviceAuthEnc }).from(chatgptDeviceLogins)) {
    const next = rewrap(row.v, `${AAD.chatgptDeviceAuth}|${row.userId}`);
    if (next) {
      // Only if it's still the same sign-in: one started meanwhile must not get the old device auth id back.
      await db
        .update(chatgptDeviceLogins)
        .set({ deviceAuthEnc: next })
        .where(and(eq(chatgptDeviceLogins.userId, row.userId), eq(chatgptDeviceLogins.deviceAuthEnc, row.v)));
      changed++;
    }
  }

  const tools = await getSetting("tools");
  if (tools.webSearch.apiKeyEnc) {
    const next = rewrap(tools.webSearch.apiKeyEnc, AAD.webSearchKey);
    if (next) {
      // Change just the ciphertext in the current JSON document. Replacing the earlier settings snapshot
      // would also roll back unrelated approval, allowlist or search configuration edited during the scan.
      const moved = await db.update(settings).set({
        value: sql`jsonb_set(${settings.value}, '{webSearch,apiKeyEnc}', to_jsonb(${next}::text), false)`,
        updatedAt: sql`now()`,
      }).where(and(eq(settings.key, "tools"), sql`${settings.value} #>> '{webSearch,apiKeyEnc}' = ${tools.webSearch.apiKeyEnc}`))
        .returning({ key: settings.key });
      changed += moved.length;
    }
  }

  return changed;
}
