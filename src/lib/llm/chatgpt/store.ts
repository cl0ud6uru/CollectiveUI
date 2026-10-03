/**
 * ChatGPT connections at rest, and the access-token service.
 *
 * Tokens are stored only in user_credentials.secret_enc: encrypted JSON bound to the row (AAD), never logged, never
 * sent to the browser. Refresh tokens rotate and are single-use (reusing one revokes the whole sign-in), so every
 * write of secret_enc happens inside a transaction holding the row lock (SELECT … FOR UPDATE), and refreshes are
 * also single-flighted in process. The re-check inside the lock is what makes the web app and worker safe together.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { chatgptDeviceLogins, userCredentials, users, type UserCredential } from "@/db/schema";
import { audit } from "@/lib/audit";
import { AAD, decrypt, encrypt, needsRewrap } from "@/lib/crypto";
import { newId } from "@/lib/ids";
import { REFRESH_WINDOW_MS } from "./constants";
import { ChatGPTNotConnectedError, ChatGPTReauthRequiredError, ChatGPTUnavailableError } from "./errors";
import { refreshTokens, revokeTokens, type TokenSet } from "./oauth";
import { readChatGPTClaims, type ChatGPTClaims } from "./policy";

type Fetch = typeof fetch;

export type ChatGPTSecret = { access: string; refresh?: string; idToken?: string };

const secretAad = (credentialId: string) => `${AAD.userCredentialSecret}|${credentialId}`;

export function sealCredentialSecret(credentialId: string, s: ChatGPTSecret): string {
  return encrypt(JSON.stringify({ v: 1, access: s.access, refresh: s.refresh, idToken: s.idToken }), secretAad(credentialId));
}

export function openCredentialSecret(row: Pick<UserCredential, "id" | "secretEnc">): ChatGPTSecret {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(decrypt(row.secretEnc, secretAad(row.id)));
  } catch {
    // Never surface the underlying message (JSON.parse quotes its input).
    throw new Error("The stored ChatGPT connection can't be read (check ENCRYPTION_KEYS)");
  }
  if (typeof obj.access !== "string" || !obj.access) throw new Error("The stored ChatGPT connection is malformed");
  return {
    access: obj.access,
    refresh: typeof obj.refresh === "string" && obj.refresh ? obj.refresh : undefined,
    idToken: typeof obj.idToken === "string" && obj.idToken ? obj.idToken : undefined,
  };
}

export async function getChatGPTCredential(userId: string): Promise<UserCredential | undefined> {
  const [row] = await db
    .select()
    .from(userCredentials)
    .where(and(eq(userCredentials.userId, userId), eq(userCredentials.provider, "chatgpt")));
  return row;
}

/** What the model fetch needs for one request. The token never leaves the server. */
export type ChatGPTAuth = {
  credentialId: string;
  accessToken: string;
  accountId: string;
  planType: string | null;
  residency: string | null;
  isFedramp: boolean;
};

const authOf = (row: UserCredential, accessToken: string): ChatGPTAuth => ({
  credentialId: row.id,
  accessToken,
  accountId: row.accountId,
  planType: row.planType,
  residency: row.residency,
  isFedramp: row.isFedramp,
});

const isFresh = (row: Pick<UserCredential, "expiresAt">) => !!row.expiresAt && row.expiresAt.getTime() - Date.now() > REFRESH_WINDOW_MS;

function expiryOf(tokens: TokenSet, claims: ChatGPTClaims | null): Date {
  return claims?.expiresAt ?? new Date(Date.now() + (tokens.expiresIn ?? 3600) * 1000);
}

type RefreshOutcome =
  | { kind: "ok"; auth: ChatGPTAuth }
  | { kind: "missing" }
  | { kind: "reauth"; reason?: string; userId?: string }
  /** `fallback`: the stored token is still valid (a proactive refresh failed), so the request can go ahead. */
  | { kind: "transient"; reason: string; fallback?: ChatGPTAuth };

/** After a transient refresh failure, keep using a still-valid token for a while instead of retrying every request. */
const REFRESH_COOLDOWN_MS = 30_000;
const refreshCooldown = new Map<string, number>();

async function refreshUnderLock(credentialId: string, rejectedToken: string | undefined, f: Fetch | undefined): Promise<ChatGPTAuth> {
  const outcome = await db.transaction(async (tx): Promise<RefreshOutcome> => {
    const [row] = await tx.select().from(userCredentials).where(eq(userCredentials.id, credentialId)).for("update");
    if (!row) return { kind: "missing" };
    if (row.status !== "active") return { kind: "reauth" };
    const secret = openCredentialSecret(row);
    // Another request (or the worker) may have refreshed while we waited for the lock.
    if (isFresh(row) && (!rejectedToken || secret.access !== rejectedToken)) return { kind: "ok", auth: authOf(row, secret.access) };

    const markReauth = async (reason: string): Promise<RefreshOutcome> => {
      await tx.update(userCredentials).set({ status: "needs_reauth", statusReason: reason, updatedAt: new Date() }).where(eq(userCredentials.id, row.id));
      return { kind: "reauth", reason, userId: row.userId };
    };
    if (!secret.refresh) return markReauth("no_refresh_token");

    const r = await refreshTokens(secret.refresh, f);
    if (!r.ok) {
      if (r.permanent) return markReauth(r.reason);
      if (r.rotatedRefreshToken) {
        // Keep the rotated refresh token (the old one may be spent) and force a refresh on the next request.
        await tx
          .update(userCredentials)
          .set({ secretEnc: sealCredentialSecret(row.id, { ...secret, refresh: r.rotatedRefreshToken }), expiresAt: new Date(), updatedAt: new Date() })
          .where(eq(userCredentials.id, row.id));
      }
      const stillValid = !rejectedToken && !r.rotatedRefreshToken && !!row.expiresAt && row.expiresAt.getTime() > Date.now();
      return { kind: "transient", reason: r.reason, ...(stillValid ? { fallback: authOf(row, secret.access) } : {}) };
    }

    const next: ChatGPTSecret = {
      access: r.tokens.accessToken,
      // The refresh token is kept when none comes back (it wasn't rotated).
      refresh: r.tokens.refreshToken ?? secret.refresh,
      idToken: r.tokens.idToken ?? secret.idToken,
    };
    // Fresh tokens win; the retained id token only fills in id-token facts (FedRAMP, residency, email) when the
    // refresh returned no id token.
    const claims = readChatGPTClaims({ idToken: r.tokens.idToken, accessToken: next.access, fallbackIdToken: secret.idToken });
    const [updated] = await tx
      .update(userCredentials)
      .set({
        secretEnc: sealCredentialSecret(row.id, next),
        expiresAt: expiryOf(r.tokens, claims),
        lastRefreshAt: new Date(),
        updatedAt: new Date(),
        ...(claims
          ? {
              accountId: claims.accountId,
              planType: claims.planType ?? row.planType,
              email: claims.email ?? row.email,
              residency: claims.residency,
              isFedramp: claims.isFedramp,
            }
          : {}),
      })
      .where(eq(userCredentials.id, row.id))
      .returning();
    return { kind: "ok", auth: authOf(updated, next.access) };
  });

  switch (outcome.kind) {
    case "ok":
      return outcome.auth;
    case "missing":
      throw new ChatGPTNotConnectedError();
    case "reauth":
      if (outcome.reason) await audit(outcome.userId ?? null, "chatgpt.reauth_required", credentialId, { reason: outcome.reason }).catch(() => {});
      throw new ChatGPTReauthRequiredError();
    case "transient":
      console.warn(`[chatgpt] token refresh failed (${outcome.reason}); will retry on a later request`);
      if (outcome.fallback) {
        refreshCooldown.set(credentialId, Date.now() + REFRESH_COOLDOWN_MS);
        return outcome.fallback;
      }
      throw new ChatGPTUnavailableError();
  }
}

const inflight = new Map<string, Promise<ChatGPTAuth>>();

/**
 * A usable access token for this person's ChatGPT connection, refreshed when it's close to expiry. Pass
 * `rejectedToken` after the backend answered 401: the token is refreshed unless someone already replaced it.
 */
export async function getChatGPTAuth(userId: string, opts: { rejectedToken?: string; fetch?: Fetch } = {}): Promise<ChatGPTAuth> {
  const row = await getChatGPTCredential(userId);
  if (!row) throw new ChatGPTNotConnectedError();
  if (row.status !== "active") throw new ChatGPTReauthRequiredError();
  const secret = openCredentialSecret(row);
  if (isFresh(row) && (!opts.rejectedToken || secret.access !== opts.rejectedToken)) return authOf(row, secret.access);
  // A proactive refresh failed moments ago and the token still works: use it rather than hammering the sign-in service.
  const coolingDown = (refreshCooldown.get(row.id) ?? 0) > Date.now();
  if (coolingDown && !opts.rejectedToken && row.expiresAt && row.expiresAt.getTime() > Date.now()) return authOf(row, secret.access);

  let pending = inflight.get(row.id);
  if (!pending) {
    pending = refreshUnderLock(row.id, opts.rejectedToken, opts.fetch).finally(() => inflight.delete(row.id));
    inflight.set(row.id, pending);
  }
  return pending;
}

export class ChatGPTUserDisabledError extends Error {
  constructor() {
    super("Your portal account is disabled.");
    this.name = "ChatGPTUserDisabledError";
  }
}

export class ChatGPTAccountInUseError extends Error {
  constructor() {
    super("This ChatGPT account is already connected by someone else in the portal. Each person connects their own account.");
    this.name = "ChatGPTAccountInUseError";
  }
}

const isUniqueViolation = (err: unknown, constraint: string) => {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const c = e?.code === "23505" ? e : e?.cause?.code === "23505" ? e.cause : undefined;
  return !!c && (c.constraint ?? "") === constraint;
};

/**
 * Stores a fresh sign-in, replacing any earlier connection of this person (whose sign-in is then revoked).
 * Throws ChatGPTAccountInUseError when another portal user already connected the same ChatGPT account, and
 * ChatGPTUserDisabledError when the person was disabled meanwhile.
 */
export async function saveChatGPTConnection(userId: string, tokens: TokenSet, claims: ChatGPTClaims, f?: Fetch): Promise<UserCredential> {
  let previous: ChatGPTSecret | undefined;
  let saved: UserCredential;
  try {
    saved = await db.transaction(async (tx) => {
      // Serializes with an admin disabling this person (which revokes their connection right after).
      const [person] = await tx.select({ disabled: users.disabled }).from(users).where(eq(users.id, userId)).for("share");
      if (!person || person.disabled) throw new ChatGPTUserDisabledError();
      const [existing] = await tx
        .select()
        .from(userCredentials)
        .where(and(eq(userCredentials.userId, userId), eq(userCredentials.provider, "chatgpt")))
        .for("update");
      const id = existing?.id ?? newId();
      if (existing) {
        try {
          previous = openCredentialSecret(existing);
        } catch {
          previous = undefined;
        }
      }
      const values = {
        secretEnc: sealCredentialSecret(id, { access: tokens.accessToken, refresh: tokens.refreshToken, idToken: tokens.idToken }),
        accountId: claims.accountId,
        planType: claims.planType,
        email: claims.email,
        externalSubject: claims.userId,
        residency: claims.residency,
        isFedramp: claims.isFedramp,
        expiresAt: expiryOf(tokens, claims),
        lastRefreshAt: new Date(),
        status: "active" as const,
        statusReason: null,
        rateLimits: null,
        rateLimitsAt: null,
        updatedAt: new Date(),
      };
      if (existing) {
        const [row] = await tx.update(userCredentials).set(values).where(eq(userCredentials.id, id)).returning();
        return row;
      }
      const [row] = await tx.insert(userCredentials).values({ id, userId, provider: "chatgpt", ...values }).returning();
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err, "user_credentials_subject_idx")) throw new ChatGPTAccountInUseError();
    throw err;
  }
  if (previous && previous.refresh !== tokens.refreshToken) void revokeTokens({ refreshToken: previous.refresh, accessToken: previous.access }, f);
  return saved;
}

/** Removes this person's connection and revokes the sign-in at OpenAI (best effort). Returns false if none. */
export async function deleteChatGPTConnection(userId: string, f?: Fetch): Promise<boolean> {
  const removed = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(userCredentials)
      .where(and(eq(userCredentials.userId, userId), eq(userCredentials.provider, "chatgpt")))
      .for("update");
    if (!row) return undefined;
    await tx.delete(userCredentials).where(eq(userCredentials.id, row.id));
    return row;
  });
  await db.delete(chatgptDeviceLogins).where(eq(chatgptDeviceLogins.userId, userId));
  if (!removed) return false;
  try {
    const s = openCredentialSecret(removed);
    await revokeTokens({ refreshToken: s.refresh, accessToken: s.access }, f);
  } catch {
    // Unreadable secret: the row is gone either way.
  }
  return true;
}

/** Admin "disconnect everyone" (and turning the feature off): deletes every connection and revokes them. */
export async function deleteAllChatGPTConnections(f?: Fetch): Promise<number> {
  const rows = await db.select({ userId: userCredentials.userId }).from(userCredentials).where(eq(userCredentials.provider, "chatgpt"));
  let n = 0;
  for (const r of rows) if (await deleteChatGPTConnection(r.userId, f)) n++;
  await db.delete(chatgptDeviceLogins);
  return n;
}

/** Latest plan usage reported by the backend (percentages and reset times only). Never touches secret_enc. */
export async function saveRateLimits(credentialId: string, rateLimits: Record<string, unknown>): Promise<void> {
  await db.update(userCredentials).set({ rateLimits, rateLimitsAt: new Date() }).where(eq(userCredentials.id, credentialId));
}

/**
 * Re-encrypts connection secrets under the primary key. Runs under the row lock like a refresh, so a rotation can
 * never write back an older refresh token.
 */
export async function rewrapChatGPTSecrets(): Promise<number> {
  let changed = 0;
  for (const { id } of await db.select({ id: userCredentials.id }).from(userCredentials)) {
    const did = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(userCredentials).where(eq(userCredentials.id, id)).for("update");
      if (!row || !needsRewrap(row.secretEnc)) return false;
      await tx.update(userCredentials).set({ secretEnc: sealCredentialSecret(row.id, openCredentialSecret(row)) }).where(eq(userCredentials.id, row.id));
      return true;
    });
    if (did) changed++;
  }
  return changed;
}
