import { createHmac, randomBytes } from "node:crypto";
import { AAD, decrypt, encrypt } from "@/lib/crypto";

/**
 * Signed per-user identity for MCP servers. The portal already knows who is chatting; this tells the server, so an
 * internal app can apply its own per-user permissions instead of trusting one shared bearer key. It is sent next to
 * the server's static headers (existing bearer keys keep working), as a short-lived HS256 JWT signed with a secret
 * only the portal and that server know. A fresh token is minted for every HTTP request.
 *
 * Claims: iss, aud (the server URL), sub (portal user id, or "portal:system" for tool-list refreshes), upn, email,
 * name, groups (portal group names), bot, conv, iat, exp (60 s), jti. Verifier snippets: docs/mcp-identity.md.
 */

export const DEFAULT_IDENTITY_HEADER = "X-Portal-Identity";
export const IDENTITY_ISSUER = "ai-portal";
export const IDENTITY_TTL_SEC = 60;
export const SYSTEM_SUBJECT = "portal:system";

export type IdentitySubject =
  | { kind: "user"; id: string; upn: string; email: string | null; name: string; groups: string[] }
  /** The portal itself (listing tools for Test and the hourly refresh), so snapshots don't depend on who clicked. */
  | { kind: "system" };

export type IdentityClaims = {
  iss: string;
  aud: string;
  sub: string;
  upn?: string;
  email?: string;
  name?: string;
  groups?: string[];
  system?: true;
  bot?: string;
  conv?: string;
  service?: ServiceIdentity;
  iat: number;
  exp: number;
  jti: string;
};

export type ServiceIdentity = {
  id: string; grant: string; revision: number; server: string; tool: string; run?: string; call: string;
};

const secretAad = (serverId: string) => `${AAD.mcpIdentitySecret}|${serverId}`;

/** 32 random bytes, base64url. Shown to the admin once, to configure on the MCP server. */
export const newIdentitySecret = () => randomBytes(32).toString("base64url");
export const sealIdentitySecret = (serverId: string, secret: string) => encrypt(secret, secretAad(serverId));
export const openIdentitySecret = (server: { id: string; identitySecretEnc: string | null }) =>
  server.identitySecretEnc ? decrypt(server.identitySecretEnc, secretAad(server.id)) : null;

/** Header names the admin may pick: a plain token, and not one the transport or HTTP itself owns. */
const RESERVED_HEADERS = /^(authorization|cookie|host|content-type|content-length|accept|connection|mcp-session-id|mcp-protocol-version|last-event-id)$/i;
export function validIdentityHeader(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(name) && !RESERVED_HEADERS.test(name);
}

export function identityClaims(
  subject: IdentitySubject,
  opts: { audience: string; botId?: string | null; conversationId?: string | null; now?: number; service?: ServiceIdentity },
): IdentityClaims {
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  const base = { iss: IDENTITY_ISSUER, aud: opts.audience, iat, exp: iat + IDENTITY_TTL_SEC, jti: randomBytes(12).toString("base64url") };
  const context = { ...(opts.botId ? { bot: opts.botId } : {}), ...(opts.conversationId ? { conv: opts.conversationId } : {}),
    ...(opts.service ? { service: opts.service } : {}) };
  if (subject.kind === "system") return { ...base, sub: SYSTEM_SUBJECT, system: true, ...context };
  return {
    ...base,
    sub: subject.id,
    upn: subject.upn,
    ...(subject.email ? { email: subject.email } : {}),
    name: subject.name,
    groups: subject.groups,
    ...context,
  };
}

/** HS256 JWT; the key is the secret string's UTF-8 bytes (what most JWT libraries do with a string secret). */
export function signIdentity(claims: IdentityClaims, secret: string): string {
  const enc = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const body = `${enc({ alg: "HS256", typ: "JWT" })}.${enc(claims)}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}
