import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPublicPath, PUBLIC_PREFIXES } from "@/lib/public-routes";

/**
 * Invariant (CLAUDE.md): every server entry point authorizes through src/lib/session.ts. These checks are
 * deliberately simple text scans so that a new route or server action without an auth call fails CI.
 */
const ROOT = path.resolve(import.meta.dirname, "../..");
const SRC = path.join(ROOT, "src");
const AUTH_CALL = /\brequire(Principal|Admin|PagePrincipal|AdminPage|PasswordPrincipal|SecurityActor|MobileSession)\s*\(/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");

/** Route handler path → URL path, e.g. src/app/api/files/[id]/route.ts → /api/files/[id]. */
function urlOf(file: string) {
  return "/" + rel(file).replace(/^src\/app\//, "").replace(/\/route\.ts$/, "").replace(/\([^)]*\)\//g, "");
}

// Public routes and actions that intentionally run without a session, and how each one authenticates instead.
const PUBLIC_HANDLERS: Record<string, string> = {
  "/api/hermes-team/native/[contextId]/model/[purpose]/[...operation]": "Opaque per-run, per-purpose native grant plus fresh server-owned Team authorization; empty verified registry denies dispatch",
  "/api/hermes-team/native/[contextId]/mcp": "Opaque per-run native tool grant plus fresh Team, adapter, connector, action/resource and approval checks",
  "/api/auth/ldap-security": "Same-origin, rate-limited, browser-bound LDAP recovery and passkey challenges; no session",
  "/api/auth/local-security": "Same-origin, rate-limited, browser-bound factor challenges and tickets only; no session",
  "/api/auth/[...nextauth]": "Auth.js sign-in endpoints",
  "/api/routines/webhook/[id]": "HMAC signature or bearer secret per routine",
  "/api/health": "no data",
  "/api/branding/logo": "only the active, normalized public logo; no settings or arbitrary files",
  "/api/branding/login-pet": "only the admin-confirmed sign-in pet at its pinned, published revision",
  "/api/mobile/info": "only the public app name/emoji and whether native sign-in is enabled",
  "/api/mobile/auth/token": "one-time, expiring, PKCE-bound code issued after a signed-in person approved the device",
};
const PUBLIC_ACTIONS: Record<string, string> = {
  "src/app/login/actions.ts:localLogin": "Auth.js credentials plus explicit same-origin check",
  "src/app/login/actions.ts:ldapLogin": "sign-in",
  "src/app/login/actions.ts:entraLogin": "sign-in",
  "src/components/sidebar/sign-out.ts:signOutAction": "sign-out",
};

describe("authorization coverage", () => {
  it("every API route handler authorizes, or is a declared public route", () => {
    const routes = walk(path.join(SRC, "app")).filter((f) => f.endsWith("/route.ts"));
    expect(routes.length).toBeGreaterThan(5);
    const missing = routes.filter((f) => {
      const url = urlOf(f);
      if (url in PUBLIC_HANDLERS) return !isPublicPath(url);
      return !AUTH_CALL.test(readFileSync(f, "utf8")) || isPublicPath(url);
    });
    expect(missing.map(rel)).toEqual([]);
  });

  it("every exported server action authorizes, or is a declared public action", () => {
    const files = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f) && /^\s*["']use server["']/.test(readFileSync(f, "utf8")));
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const all = [...src.matchAll(/^(export )?(?:async )?function (\w+)\s*\(/gm)];
      const bodyOf = (i: number) => src.slice(all[i].index!, all[i + 1]?.index ?? src.length);
      // Local helpers (e.g. assertCanCreate) that call require*() count as authorizing.
      const helpers = all.filter((m, i) => !m[1] && AUTH_CALL.test(bodyOf(i))).map((m) => m[2]);
      const authorizes = new RegExp(`${AUTH_CALL.source}|\\b(${helpers.join("|") || "$^"})\\s*\\(`);
      all.forEach((m, i) => {
        if (!m[1]) return;
        const id = `${rel(f)}:${m[2]}`;
        if (!(id in PUBLIC_ACTIONS) && !authorizes.test(bodyOf(i))) missing.push(id);
      });
    }
    expect(missing).toEqual([]);
  });

  it("proxy.ts uses the shared public path list, and it covers exactly the public handlers", () => {
    expect(readFileSync(path.join(SRC, "proxy.ts"), "utf8")).toContain("isPublicPath(");
    for (const url of Object.keys(PUBLIC_HANDLERS)) expect(isPublicPath(url), url).toBe(true);
    const apiPrefixes = PUBLIC_PREFIXES.filter((p) => p.startsWith("/api/"));
    for (const p of apiPrefixes) expect(Object.keys(PUBLIC_HANDLERS).some((u) => u.startsWith(p)), p).toBe(true);
    expect(isPublicPath("/api/healthz")).toBe(false);
    expect(isPublicPath("/api/chat")).toBe(false);
    expect(isPublicPath("/api/branding/logo/private")).toBe(false);
    expect(isPublicPath("/api/branding/login-pet/other")).toBe(false);
    expect(isPublicPath("/api/admin/branding/logo")).toBe(false);
  });
});
