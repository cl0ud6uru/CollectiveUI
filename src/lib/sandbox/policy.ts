import { stripHidden } from "@/lib/mcp/hygiene";
import { redactSecrets } from "@/lib/redact";
import type { SandboxSettings } from "@/lib/settings";

type PrincipalLike = { user: { upn: string }; groupIds: string[]; isAdmin: boolean };

/** Whether this person gets a workspace. Admins always do while the feature is on (to try it). */
export function userMayUseWorkspace(p: PrincipalLike, s: SandboxSettings): boolean {
  if (!s.enabled) return false;
  if (p.isAdmin || s.access === "everyone") return true;
  const upn = p.user.upn.toLowerCase();
  return s.allowedUpns.some((u) => u.trim().toLowerCase() === upn) || p.groupIds.some((g) => s.allowedGroupIds.includes(g));
}

/** The isolation to ask sandboxd for: gVisor unless an admin acknowledged running on runc. */
export const requiredIsolation = (s: SandboxSettings) => (s.allowRunc ? ("any" as const) : ("gvisor" as const));

/**
 * A guard against obvious foot-guns (wiping the workspace root, fork bombs, formatting devices). NOT a security
 * control: shell strings are trivially obfuscated. The boundary is the container (no network, no privileges, its own
 * volume), and every command already needs the person's approval.
 */
const HARD_DENIED: [RegExp, string][] = [
  [/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&[^}]*\}\s*;?\s*:/, "a fork bomb"],
  [/\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z-]+\s+)*(\/|~|\/home\/agent|\$HOME)\/?\*?(\s|;|&|\||$)/, "deleting the whole workspace or filesystem"],
  [/--no-preserve-root/, "deleting the filesystem root"],
  [/\bmkfs(\.\w+)?\b/, "formatting a filesystem"],
  [/\bdd\b[^|;&]*\bof=\/dev\//, "writing to a raw device"],
];

export function isHardDenied(command: string): string | null {
  for (const [re, what] of HARD_DENIED) if (re.test(command)) return `This command looks like ${what}, so it isn't run.`;
  return null;
}

/** Text for people and the model: lossy UTF-8, hidden characters stripped, anything that looks like a secret masked. */
export function cleanText(input: Uint8Array | string): string {
  const text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: false }).decode(input);
  return redactSecrets(stripHidden(text));
}

/**
 * Keeps the start and the end of long output (the end usually holds the error), with a note about what was cut.
 * Sizes are in characters, after cleaning.
 */
export function capHeadTail(text: string, head: number, tail: number): { text: string; omitted: number } {
  if (text.length <= head + tail) return { text, omitted: 0 };
  const omitted = text.length - head - tail;
  return { text: `${text.slice(0, head)}\n… [${omitted} characters omitted] …\n${text.slice(text.length - tail)}`, omitted };
}

/** Binary content: a NUL byte in the first 8 KB (what git and grep do). */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}
