import { createHash, timingSafeEqual } from "node:crypto";
import { getToken } from "next-auth/jwt";
import type { NextAuthConfig } from "next-auth";
import { HttpError } from "@/lib/http-error";
import { absoluteSessionDeadline } from "./session-state";
import { revokeWebSession, webSessionIdentity, type WebSessionIdentity } from "./web-sessions";

type Revoke = (identity: WebSessionIdentity) => Promise<void>;
const COOKIE_BODY_LIMIT = 16 * 1024;
const denied = () => new HttpError(403, "Invalid sign-out request");

/** Match the same action component Auth.js accepts, including trailing/duplicate slashes. */
export function isHttpLogout(req: Request, config: NextAuthConfig): boolean {
  const base = (config.basePath ?? "/api/auth").replace(/\/$/, ""); const path = new URL(req.url).pathname;
  return path.startsWith(`${base}/`) && path.slice(base.length).split("/").filter(Boolean)[0] === "signout";
}

function origin(req: Request, env: Record<string, string | undefined>) {
  return new URL(env.AUTH_URL ?? env.NEXTAUTH_URL ?? req.url).origin;
}
function cookieNames(req: Request, config: NextAuthConfig, env: Record<string, string | undefined>) {
  const secure = config.useSecureCookies ?? origin(req, env).startsWith("https:");
  return {
    session: config.cookies?.sessionToken?.name ?? `${secure ? "__Secure-" : ""}authjs.session-token`,
    csrf: config.cookies?.csrfToken?.name ?? `${secure ? "__Host-" : ""}authjs.csrf-token`,
  };
}
function cookieValue(headers: Headers, name: string): string | null {
  const values = (headers.get("cookie") ?? "").split(";").map(v => v.trim()).filter(v => v.startsWith(`${name}=`));
  if (values.length > 1) throw denied();
  if (!values.length) return null;
  try { return decodeURIComponent(values[0].slice(name.length + 1)); } catch { throw denied(); }
}

/** Decode the ORIGINAL signed cookie, not auth() (which returns null after revocation). No bearer fallback. */
export async function verifiedLogoutSession(req: Request, config: NextAuthConfig, env: Record<string, string | undefined> = process.env): Promise<WebSessionIdentity | null> {
  const names = cookieNames(req, config, env);
  const entries = (req.headers.get("cookie") ?? "").split(";").map(v => v.trim().split("=", 1)[0]);
  const chunks = entries.filter(k => k === names.session || k.startsWith(`${names.session}.`));
  if (!chunks.length) return null;
  if (chunks.length > 16 || new Set(chunks).size !== chunks.length) throw denied();
  if (!config.secret?.length) throw new HttpError(503, "Sign-out is unavailable");
  const headers = new Headers(req.headers); headers.delete("authorization");
  const token = await getToken({ req: { headers }, secret: config.secret, cookieName: names.session, salt: names.session,
    decode: config.jwt?.decode });
  if (!token) throw denied();
  const identity = webSessionIdentity({ ...token, sessionVersion: token.sessionVersion ?? 0, sessionDeadline: absoluteSessionDeadline(token) });
  if (!identity) throw denied();
  return identity;
}

async function boundedSignoutBody(req: Request): Promise<string> {
  const reader = req.body?.getReader(); if (!reader) throw denied();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const value = await reader.read(); if (value.done) break;
      size += value.value.byteLength;
      if (size > COOKIE_BODY_LIMIT) { void reader.cancel(); throw denied(); }
      chunks.push(value.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

/** Verify origin + the same Auth.js secret-bound double-submit proof BEFORE any revocation side effect. */
export async function commitHttpLogout(req: Request, config: NextAuthConfig, revoke: Revoke = revokeWebSession,
  env: Record<string, string | undefined> = process.env): Promise<Request> {
  if (req.method !== "POST" || req.headers.get("origin") !== origin(req, env) || req.headers.get("sec-fetch-site") === "cross-site") throw denied();
  const body = await boundedSignoutBody(req); const type = req.headers.get("content-type")?.split(";")[0];
  let submitted: unknown;
  try {
    if (type === "application/x-www-form-urlencoded") {
      const params = new URLSearchParams(body); if (params.getAll("csrfToken").length !== 1) throw denied(); submitted = params.get("csrfToken");
    } else if (type === "application/json") submitted = JSON.parse(body).csrfToken;
    else throw denied();
  } catch { throw denied(); }
  const cookie = cookieValue(req.headers, cookieNames(req, config, env).csrf);
  const parts = cookie?.split("|");
  if (!config.secret?.length || typeof submitted !== "string" || submitted.length > 256 || !parts || parts.length !== 2 ||
      parts[0] !== submitted || !/^[a-f0-9]{64}$/.test(parts[1])) throw denied();
  // Preserve the installed Auth.js semantics for secret arrays: createCSRFToken concatenates options.secret.
  const expected = createHash("sha256").update(`${submitted}${config.secret}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(parts[1], "hex"))) throw denied();
  const identity = await verifiedLogoutSession(req, config, env);
  if (identity) await revoke(identity); // Any decode/DB failure prevents delegation and cookie clearing.
  const headers = new Headers(req.headers); headers.delete("content-length");
  return new Request(req.url, { method: "POST", headers, body });
}

/** Server actions already pass Next.js's origin/CSRF admission; still commit revocation before signOut writes cookies. */
export async function commitServerLogout(headers: Headers, config: NextAuthConfig, revoke: Revoke = revokeWebSession,
  env: Record<string, string | undefined> = process.env): Promise<void> {
  const base = env.AUTH_URL ?? env.NEXTAUTH_URL ?? `${headers.get("x-forwarded-proto") === "https" ? "https" : "http"}://${headers.get("host") ?? "localhost"}`;
  const identity = await verifiedLogoutSession(new Request(new URL("/api/auth/signout", base), { headers }), config, env);
  if (identity) await revoke(identity);
}
