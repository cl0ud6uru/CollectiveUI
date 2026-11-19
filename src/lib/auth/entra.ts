import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { userTokens } from "@/db/schema";
import { AAD, decrypt, encrypt, encryptOptional } from "@/lib/crypto";

const GRAPH = "https://graph.microsoft.com/v1.0";

/** Used when the id_token signals group overage (>200 groups). */
export async function fetchEntraGroupsViaGraph(accessToken: string): Promise<string[]> {
  const ids: string[] = [];
  let url: string | undefined = `${GRAPH}/me/transitiveMemberOf/microsoft.graph.group?$select=id&$top=999`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Graph groups lookup failed: ${res.status}`);
    const body = (await res.json()) as { value: { id: string }[]; "@odata.nextLink"?: string };
    ids.push(...body.value.map((g) => g.id));
    url = body["@odata.nextLink"];
  }
  return ids;
}

type OAuthAccount = {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  scope?: string;
};

function tokenValues(accessToken: string, account: OAuthAccount) {
  const expiresAt = new Date((account.expires_at ?? Math.floor(Date.now() / 1000) + 3600) * 1000);
  return {
    accessTokenEnc: encrypt(accessToken, AAD.userAccessToken),
    refreshTokenEnc: encryptOptional(account.refresh_token, AAD.userRefreshToken),
    expiresAt,
    scope: account.scope ?? null,
    updatedAt: new Date(),
  };
}

export async function saveEntraTokens(userId: string, account: OAuthAccount) {
  if (!account.access_token) return;
  const values = tokenValues(account.access_token, account);
  await db.insert(userTokens).values({ userId, ...values }).onConflictDoUpdate({ target: userTokens.userId, set: values });
}

type EntraTokens = typeof userTokens.$inferSelect;

async function refreshGraphToken(row: EntraTokens, signal?: AbortSignal | null) {
  const issuer = process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER; // https://login.microsoftonline.com/<tenant>/v2.0
  if (!row.refreshTokenEnc || !issuer) return null;
  const refresh = decrypt(row.refreshTokenEnc, AAD.userRefreshToken);
  const tokenUrl = issuer.replace(/\/v2\.0\/?$/, "") + "/oauth2/v2.0/token";
  const res = await fetch(tokenUrl, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.AUTH_MICROSOFT_ENTRA_ID_ID ?? "",
      client_secret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET ?? "",
      grant_type: "refresh_token",
      refresh_token: refresh,
      scope: row.scope ?? "openid offline_access User.Read",
    }),
  });
  if (res.ok) {
    const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
    const values = tokenValues(t.access_token, {
      refresh_token: t.refresh_token ?? refresh,
      expires_at: Math.floor(Date.now() / 1000) + t.expires_in,
      scope: t.scope ?? row.scope ?? undefined,
    });
    // A sign-in, a second refresh or removal may have committed during the provider round-trip.
    const updated = await db.update(userTokens).set(values).where(and(
      eq(userTokens.userId, row.userId),
      eq(userTokens.accessTokenEnc, row.accessTokenEnc),
      eq(userTokens.refreshTokenEnc, row.refreshTokenEnc),
    )).returning({ userId: userTokens.userId });
    if (updated.length) return t.access_token;
  }

  return null;
}

/** Returns a valid delegated Graph token for the user, refreshing it if needed. */
export async function getGraphToken(userId: string, signal?: AbortSignal | null): Promise<string | null> {
  let previous: EntraTokens | undefined;
  // If credentials changed during refresh, allow one attempt with the replacement pair.
  const maxRefreshes = 2;
  for (let refreshes = 0; refreshes <= maxRefreshes; refreshes++) {
    signal?.throwIfAborted();
    const [row] = await db.select().from(userTokens).where(eq(userTokens.userId, userId));
    signal?.throwIfAborted();
    if (!row || (previous && row.accessTokenEnc === previous.accessTokenEnc && row.refreshTokenEnc === previous.refreshTokenEnc)) return null;
    if (row.expiresAt.getTime() - Date.now() > 120_000) return decrypt(row.accessTokenEnc, AAD.userAccessToken);
    if (refreshes === maxRefreshes) break;
    const token = await refreshGraphToken(row, signal);
    if (token) return token;
    previous = row;
  }
  return null;
}

export async function graphFetch<T = void>(userId: string, path: string, init?: RequestInit): Promise<T> {
  init?.signal?.throwIfAborted();
  const token = await getGraphToken(userId, init?.signal);
  init?.signal?.throwIfAborted();
  if (!token) throw new Error("Microsoft 365 is not connected for this user. Sign in with Microsoft to enable it.");
  const res = await fetch(path.startsWith("http") ? path : `${GRAPH}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Microsoft Graph error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  // The mail effect is acknowledged by these headers. Reading its empty body afterward can still abort on Stop.
  if (res.status === 204 || (res.status === 202 && path === "/me/sendMail")) return undefined as T;
  const body = await res.text();
  if (!body && (res.status === 202 || res.status === 204)) return undefined as T;
  return JSON.parse(body) as T;
}
