import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { liveActivities, aiApps, chatgptDeviceLogins, hermesConnections, mcpServers, routines, userTokens, providerConnections } from "@/db/schema";
import { connectionAAD } from "@/lib/hermes-provisioning/config";
import { AAD, encrypt, needsRewrap, rewrap } from "@/lib/crypto";
import { rewrapChatGPTSecrets } from "@/lib/llm/chatgpt/store";
import { appSecretNeedsRowBinding, openAppSecret, sealAppSecret } from "@/lib/llm/secrets";
import { providerConnectionAad } from "@/lib/llm/provider-connections";
import { getSetting, setSetting } from "@/lib/settings";

/**
 * Re-encrypts every stored secret under the primary key (with AAD). Idempotent: values that are already
 * current are left alone. Runs at worker start so a key rotation only needs a new ENCRYPTION_PRIMARY_KID.
 * Also encrypts routine webhook secrets that were stored as plaintext before encryption was added.
 */
export async function rewrapAllSecrets(): Promise<number> {
  let changed = 0;
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

  // App credentials are bound to their row (AAD "ai_apps.api_key_enc|<id>"); older values used the column only.
  for (const row of await db.select({ id: aiApps.id, apiKeyEnc: aiApps.apiKeyEnc }).from(aiApps).where(isNotNull(aiApps.apiKeyEnc))) {
    if (!appSecretNeedsRowBinding(row) && !needsRewrap(row.apiKeyEnc!)) continue;
    await db.update(aiApps).set({ apiKeyEnc: sealAppSecret(row.id, openAppSecret(row)!) }).where(eq(aiApps.id, row.id));
    changed++;
  }

  for (const row of await db.select({ id: mcpServers.id, v: mcpServers.headersEnc }).from(mcpServers).where(isNotNull(mcpServers.headersEnc))) {
    const next = rewrap(row.v!, AAD.mcpHeaders);
    if (next) {
      await db.update(mcpServers).set({ headersEnc: next }).where(eq(mcpServers.id, row.id));
      changed++;
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
      await db
        .update(userTokens)
        .set({ ...(access ? { accessTokenEnc: access } : {}), ...(refresh ? { refreshTokenEnc: refresh } : {}) })
        .where(eq(userTokens.userId, row.userId));
      changed++;
    }
  }

  for (const row of await db.select({ id: routines.id, v: routines.webhookSecret }).from(routines).where(isNotNull(routines.webhookSecret))) {
    const next = row.v!.startsWith("v2.") ? rewrap(row.v!, AAD.routineWebhookSecret) : encrypt(row.v!, AAD.routineWebhookSecret);
    if (next) {
      await db.update(routines).set({ webhookSecret: next }).where(eq(routines.id, row.id));
      changed++;
    }
  }

  // ChatGPT connections are rewrapped under their row lock (refresh tokens must never be written back stale).
  changed += await rewrapChatGPTSecrets();
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
      await setSetting("tools", { ...tools, webSearch: { ...tools.webSearch, apiKeyEnc: next } });
      changed++;
    }
  }

  return changed;
}
