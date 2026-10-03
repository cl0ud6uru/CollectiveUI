import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userTokens } from "@/db/schema";
import { AAD, decrypt, decryptOptional, encrypt, encryptOptional } from "@/lib/crypto";

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

export async function saveEntraTokens(userId: string, account: OAuthAccount) {
  if (!account.access_token) return;
  const expiresAt = new Date((account.expires_at ?? Math.floor(Date.now() / 1000) + 3600) * 1000);
  const values = {
    userId,
    accessTokenEnc: encrypt(account.access_token, AAD.userAccessToken),
    refreshTokenEnc: encryptOptional(account.refresh_token, AAD.userRefreshToken),
    expiresAt,
    scope: account.scope ?? null,
    updatedAt: new Date(),
  };
  await db.insert(userTokens).values(values).onConflictDoUpdate({ target: userTokens.userId, set: values });
}

/** Returns a valid delegated Graph token for the user, refreshing it if needed. */
export async function getGraphToken(userId: string): Promise<string | null> {
  const [row] = await db.select().from(userTokens).where(eq(userTokens.userId, userId));
  if (!row) return null;
  if (row.expiresAt.getTime() - Date.now() > 120_000) return decrypt(row.accessTokenEnc, AAD.userAccessToken);

  const refresh = decryptOptional(row.refreshTokenEnc, AAD.userRefreshToken);
  const issuer = process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER; // https://login.microsoftonline.com/<tenant>/v2.0
  if (!refresh || !issuer) return null;
  const tokenUrl = issuer.replace(/\/v2\.0\/?$/, "") + "/oauth2/v2.0/token";
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.AUTH_MICROSOFT_ENTRA_ID_ID ?? "",
      client_secret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET ?? "",
      grant_type: "refresh_token",
      refresh_token: refresh,
      scope: row.scope ?? "openid offline_access User.Read",
    }),
  });
  if (!res.ok) return null;
  const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
  await saveEntraTokens(userId, {
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? refresh,
    expires_at: Math.floor(Date.now() / 1000) + t.expires_in,
    scope: t.scope ?? row.scope ?? undefined,
  });
  return t.access_token;
}

export async function graphFetch<T>(userId: string, path: string, init?: RequestInit): Promise<T> {
  const token = await getGraphToken(userId);
  if (!token) throw new Error("Microsoft 365 is not connected for this user. Sign in with Microsoft to enable it.");
  const res = await fetch(path.startsWith("http") ? path : `${GRAPH}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Microsoft Graph error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}
