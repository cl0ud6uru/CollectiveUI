import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// Node/OpenSSL's memory-hard scrypt; OWASP minimum N=2^17, r=8, p=1 (~128 MiB).
const N = 131072;
const options = { N, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
const prefix = `scrypt$${N}$8$1`;
let active = 0;
export class PasswordBusy extends Error {}
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  // Bound native memory and queued work even under concurrent requests; fail closed, never downgrade.
  if (active >= 2) throw new PasswordBusy("Authentication busy. Try again shortly.");
  active++;
  try {
    return await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, options, (err, key) => err ? reject(err) : resolve(key)));
  } finally { active--; }
}
export const PASSWORD_GUIDANCE = "Use 15–128 characters (up to 512 UTF-8 bytes), preferably a unique passphrase.";
export function validPasswordInput(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 && Buffer.byteLength(value, "utf8") <= 512 && !value.includes("\0");
}
export function validateNewPassword(value: unknown): asserts value is string {
  if (!validPasswordInput(value) || [...value].length < 15 || [...value].length > 128 || !value.trim()) throw new Error(PASSWORD_GUIDANCE);
  if (/^(.)\1+$/u.test(value) || /^(password|1234567890|qwerty|letmein)[\d!@#$%^&*\s]*$/i.test(value)) throw new Error("Choose a less predictable passphrase.");
}
export async function hashPassword(password: string) {
  validateNewPassword(password);
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `${prefix}$${salt.toString("hex")}$${key.toString("hex")}`;
}
// Unknown users still pay the same KDF cost. This is not an account or an accepted password hash.
const dummy = `${prefix}$${"00".repeat(16)}$${"00".repeat(64)}`;
export async function verifyPassword(password: unknown, encoded?: string | null) {
  if (!validPasswordInput(password)) return false;
  const value = encoded ?? dummy;
  const match = /^scrypt\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(value);
  // Invalid/unknown formats fail closed without letting DB contents set attacker-controlled KDF costs.
  const parts = match ?? /^scrypt\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(dummy)!;
  const actual = await derive(password, Buffer.from(parts[1], "hex"));
  return timingSafeEqual(actual, Buffer.from(parts[2], "hex")) && !!encoded && !!match;
}
