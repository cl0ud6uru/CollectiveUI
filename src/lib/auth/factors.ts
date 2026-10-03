import { generateSecret, generateURI, verify } from "otplib";
import { decrypt, encrypt, keyring, randomToken, sha256Hex } from "@/lib/crypto";

export const SECURITY_ERROR = "Unable to verify. Start again and check your credentials, or try again later.";
export class SecurityError extends Error { constructor() { super(SECURITY_ERROR); } }
export function securityConfig() {
  const url = new URL(process.env.AUTH_URL ?? "");
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "") ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost" && process.env.NODE_ENV !== "production"))) throw new SecurityError();
  return { origin: url.origin, rpID: url.hostname, rpName: "CollectiveUI", secure: url.protocol === "https:" };
}
export function bindingCookieName() { return securityConfig().secure ? "__Host-collective-preauth" : "collective-preauth"; }
export function readBinding(headers: Headers) {
  const name = bindingCookieName();
  const values = (headers.get("cookie") ?? "").split(";").map(s => s.trim()).filter(s => s.startsWith(`${name}=`));
  return values.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0].slice(name.length + 1)) ? values[0].slice(name.length + 1) : "";
}
export function assertSecurityOrigin(headers: Headers) {
  if (headers.get("origin") !== securityConfig().origin || headers.get("sec-fetch-site") === "cross-site") throw new SecurityError();
}
function requireTotpKey() {
  const entries = (process.env.ENCRYPTION_KEYS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const raw = entries.map(s => s.slice(s.indexOf(":") + 1));
  if (process.env.ENCRYPTION_KEY) raw.push(process.env.ENCRYPTION_KEY);
  if (!raw.length || raw.some(s => !/^[A-Za-z0-9+/]{43}=$/.test(s) || Buffer.from(s, "base64").toString("base64") !== s)) throw new SecurityError();
  keyring();
}
const aad = (userId: string) => `local_security.totp|${userId}`;
export function sealTotp(secret: string, userId: string) { requireTotpKey(); return encrypt(secret, aad(userId)); }
export function openTotp(ciphertext: string, userId: string) {
  requireTotpKey();
  if (!ciphertext.startsWith("v2.")) throw new SecurityError();
  return decrypt(ciphertext, aad(userId));
}
export function createTotp(userId: string, username: string) {
  const secret = generateSecret();
  return { secret, totpEnc: sealTotp(secret, userId), uri: generateURI({ issuer: "CollectiveUI", label: username, secret, algorithm: "sha1", digits: 6, period: 30 }) };
}
export async function checkTotp(totpEnc: string, userId: string, token: string, afterTimeStep?: number) {
  if (!/^\d{6}$/.test(token)) throw new SecurityError();
  const result = await verify({ secret: openTotp(totpEnc, userId), token, algorithm: "sha1", digits: 6, period: 30, epochTolerance: 30, afterTimeStep });
  if (!result.valid || !("timeStep" in result)) throw new SecurityError();
  return result.timeStep;
}
export function recoveryHash(userId: string, code: string) { return sha256Hex(`recovery|${userId}|${code.trim().toUpperCase()}`); }
export function createRecoveryCodes() {
  return Array.from({ length: 10 }, () => Buffer.from(randomToken("", 20), "base64url").toString("hex").toUpperCase().match(/.{1,8}/g)!.join("-"));
}
