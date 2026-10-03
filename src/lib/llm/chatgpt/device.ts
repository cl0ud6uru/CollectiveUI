/**
 * The "Connect ChatGPT" device-code flow, run entirely on the server:
 *  1. start: ask OpenAI for a user code and keep the device auth id (encrypted) for 15 minutes. A sign-in already in
 *     progress is reused, so every tab shows the same code and repeated clicks never reach OpenAI again;
 *  2. poll: the browser calls in every few seconds; each call makes at most one upstream poll, and only after the
 *     server-side next_poll_at has passed. The slot is claimed atomically and held for longer than an upstream call
 *     can take, so two tabs never poll at the same time;
 *  3. on approval: the pending row is deleted first and the code is exchanged only if that delete removed it (a
 *     cancel, "Disconnect everyone" or disabling the person wins), then the account is checked against the admin
 *     rules and the tokens are stored.
 */
import { and, eq, lt, lte } from "drizzle-orm";
import { db } from "@/db";
import { chatgptDeviceLogins, type UserCredential } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { audit } from "@/lib/audit";
import { HttpError } from "@/lib/authz";
import { AAD, decrypt, encrypt } from "@/lib/crypto";
import { getSetting } from "@/lib/settings";
import { DEVICE_CODE_TTL_MS, deviceVerificationUrl } from "./constants";
import { ChatGPTAuthFlowError, exchangeAuthorizationCode, pollDeviceCode, requestDeviceCode, revokeTokens } from "./oauth";
import { accountRejection, readChatGPTClaims, userMayUseChatGPT } from "./policy";
import { ChatGPTAccountInUseError, ChatGPTUserDisabledError, saveChatGPTConnection } from "./store";

type Fetch = typeof fetch;

const deviceAad = (userId: string) => `${AAD.chatgptDeviceAuth}|${userId}`;

/** How long a poll holds its slot: longer than an upstream call can take (20 s timeout). */
const CLAIM_LEASE_SEC = 25;
/** A pending sign-in with less time left than this is replaced by a new one on start. */
const MIN_REUSE_MS = 60_000;

async function assertMayConnect(p: Principal) {
  const s = await getSetting("chatgpt");
  if (!s.enabled) throw new HttpError(403, "Sign in with ChatGPT is turned off.");
  if (!userMayUseChatGPT(p, s)) throw new HttpError(403, "Your organization hasn't allowed you to connect a ChatGPT plan.");
  return s;
}

export type DeviceLoginStart = { userCode: string; verificationUrl: string; intervalSec: number; expiresAt: string };

/** The person's sign-in in progress, if any (what the browser may see: never the device auth id). */
export async function getPendingChatGPTLogin(userId: string, minRemainingMs = 0): Promise<DeviceLoginStart | null> {
  const [row] = await db.select().from(chatgptDeviceLogins).where(eq(chatgptDeviceLogins.userId, userId));
  if (!row || row.expiresAt.getTime() - Date.now() <= minRemainingMs) return null;
  return { userCode: row.userCode, verificationUrl: deviceVerificationUrl(), intervalSec: row.intervalSec, expiresAt: row.expiresAt.toISOString() };
}

export async function startChatGPTDeviceLogin(p: Principal, f?: Fetch): Promise<DeviceLoginStart> {
  await assertMayConnect(p);
  const pending = await getPendingChatGPTLogin(p.user.id, MIN_REUSE_MS);
  if (pending) return pending;
  let code;
  try {
    code = await requestDeviceCode(f);
  } catch (err) {
    if (err instanceof ChatGPTAuthFlowError) throw new HttpError(err.code === "disabled" ? 400 : 503, err.message);
    throw err;
  }
  const now = Date.now();
  const row = {
    deviceAuthEnc: encrypt(code.deviceAuthId, deviceAad(p.user.id)),
    userCode: code.userCode,
    intervalSec: code.intervalSec,
    nextPollAt: new Date(now + code.intervalSec * 1000),
    expiresAt: new Date(now + DEVICE_CODE_TTL_MS),
    createdAt: new Date(now),
  };
  // First writer wins when two tabs start at once: an existing sign-in is only replaced when it's about to expire,
  // otherwise both tabs get the one the server is polling.
  const inserted = await db.insert(chatgptDeviceLogins).values({ userId: p.user.id, ...row }).onConflictDoNothing().returning({ userId: chatgptDeviceLogins.userId });
  if (!inserted.length) {
    const replaced = await db
      .update(chatgptDeviceLogins)
      .set(row)
      .where(and(eq(chatgptDeviceLogins.userId, p.user.id), lt(chatgptDeviceLogins.expiresAt, new Date(now + MIN_REUSE_MS))))
      .returning({ userId: chatgptDeviceLogins.userId });
    if (!replaced.length) {
      const existing = await getPendingChatGPTLogin(p.user.id);
      if (existing) return existing;
    }
  }
  return { userCode: code.userCode, verificationUrl: deviceVerificationUrl(), intervalSec: code.intervalSec, expiresAt: row.expiresAt.toISOString() };
}

export type DeviceLoginPoll =
  | { status: "none" }
  | { status: "pending"; intervalSec: number }
  | { status: "expired" }
  | { status: "failed"; error: string }
  | { status: "connected"; connection: Pick<UserCredential, "email" | "planType" | "accountId"> };

export async function pollChatGPTDeviceLogin(p: Principal, f?: Fetch): Promise<DeviceLoginPoll> {
  const settings = await assertMayConnect(p);
  const userId = p.user.id;
  const [login] = await db.select().from(chatgptDeviceLogins).where(eq(chatgptDeviceLogins.userId, userId));
  if (!login) return { status: "none" };
  // Every write below is tied to this exact sign-in, so a newer one (or a cancel) is never touched. Keyed on values
  // that never change for a sign-in (not the ciphertext, which a key-rotation rewrap replaces).
  const thisLogin = and(
    eq(chatgptDeviceLogins.userId, userId),
    eq(chatgptDeviceLogins.userCode, login.userCode),
    eq(chatgptDeviceLogins.createdAt, login.createdAt),
  );
  const finish = async () => (await db.delete(chatgptDeviceLogins).where(thisLogin).returning({ userId: chatgptDeviceLogins.userId })).length > 0;
  if (login.expiresAt.getTime() <= Date.now()) {
    await finish();
    return { status: "expired" };
  }

  // Claim this poll slot for longer than an upstream call can take; concurrent callers get "pending" without
  // touching OpenAI.
  const [claimed] = await db
    .update(chatgptDeviceLogins)
    .set({ nextPollAt: new Date(Date.now() + Math.max(login.intervalSec, CLAIM_LEASE_SEC) * 1000) })
    .where(and(thisLogin, lte(chatgptDeviceLogins.nextPollAt, new Date())))
    .returning();
  if (!claimed) return { status: "pending", intervalSec: login.intervalSec };

  const deviceAuthId = decrypt(login.deviceAuthEnc, deviceAad(userId));
  const r = await pollDeviceCode(deviceAuthId, login.userCode, f);
  if (r.status === "pending" || r.status === "slow_down") {
    const intervalSec = r.status === "slow_down" ? Math.min(30, login.intervalSec + 5) : login.intervalSec;
    await db
      .update(chatgptDeviceLogins)
      .set({ intervalSec, nextPollAt: new Date(Date.now() + intervalSec * 1000) })
      .where(thisLogin);
    return { status: "pending", intervalSec };
  }
  // Approved or failed: this sign-in attempt is over. Only the caller whose delete removed the row goes on, so a
  // cancel, "Disconnect everyone" or disabling the person in the meantime means the code is never exchanged.
  if (!(await finish())) return { status: "none" };
  if (r.status === "failed") return { status: "failed", error: r.message };

  let tokens;
  try {
    tokens = await exchangeAuthorizationCode(r.authorizationCode, r.codeVerifier, f);
  } catch (err) {
    return { status: "failed", error: err instanceof ChatGPTAuthFlowError ? err.message : "Sign-in failed. Start again." };
  }
  const claims = readChatGPTClaims({ idToken: tokens.idToken, accessToken: tokens.accessToken });
  const rejection = claims ? accountRejection(claims, settings) : "The sign-in didn't include a ChatGPT account.";
  if (!claims || rejection) {
    void revokeTokens(tokens, f);
    await audit(userId, "chatgpt.connect_rejected", userId, { plan: claims?.planType ?? null, accountId: claims?.accountId ?? null }).catch(() => {});
    return { status: "failed", error: rejection ?? "Sign-in failed." };
  }
  let saved;
  try {
    saved = await saveChatGPTConnection(userId, tokens, claims, f);
  } catch (err) {
    void revokeTokens(tokens, f);
    if (err instanceof ChatGPTAccountInUseError || err instanceof ChatGPTUserDisabledError) return { status: "failed", error: err.message };
    throw err;
  }
  // The connection is stored: a failing audit write must not undo (revoke) it.
  await audit(userId, "chatgpt.connect", saved.id, { plan: claims.planType, accountId: claims.accountId }).catch((err) =>
    console.error("[chatgpt] audit failed", err),
  );
  return { status: "connected", connection: { email: saved.email, planType: saved.planType, accountId: saved.accountId } };
}

export async function cancelChatGPTDeviceLogin(userId: string): Promise<void> {
  await db.delete(chatgptDeviceLogins).where(eq(chatgptDeviceLogins.userId, userId));
}
