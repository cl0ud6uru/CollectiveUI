import { createHash, randomUUID } from "node:crypto";
import { encode } from "next-auth/jwt";
import type { NextAuthConfig } from "next-auth";
import { describe, expect, it, vi } from "vitest";
import { commitHttpLogout, commitServerLogout } from "@/lib/auth/web-logout";

vi.mock("@/db", () => ({ db: null }));
const secret = "synthetic-test-only-auth-secret-".repeat(2);
async function fixture(secure = true, secrets: string | string[] = secret, chunked = false) {
  const sessionId = randomUUID(); const name = `${secure ? "__Secure-" : ""}authjs.session-token`;
  const config: NextAuthConfig = { providers: [], secret: secrets };
  const token = { uid: "owner-a", authSessionId: sessionId, sessionVersion: 1, sessionDeadline: Date.now() / 1000 + 3600, padding: chunked ? "p".repeat(10_000) : "" };
  const jwt = await encode({ token, secret: Array.isArray(secrets) ? secrets.at(-1)! : secrets, salt: name });
  const csrf = "synthetic-csrf"; const proof = createHash("sha256").update(`${csrf}${secrets}`).digest("hex");
  const sessionCookie = chunked ? Array.from({ length: Math.ceil(jwt.length / 3000) }, (_, i) => `${name}.${i}=${jwt.slice(i * 3000, (i + 1) * 3000)}`).join("; ") : `${name}=${jwt}`;
  const cookie = `${sessionCookie}; ${secure ? "__Host-" : ""}authjs.csrf-token=${encodeURIComponent(`${csrf}|${proof}`)}`;
  const base = `${secure ? "https" : "http"}://portal.example`;
  const request = () => new Request(`${base}/api/auth/signout`, { method: "POST", headers: { origin: base, cookie, "content-type": "application/x-www-form-urlencoded" }, body: `csrfToken=${csrf}` });
  return { config, sessionId, request, base, cookie };
}
describe("logout commits before clearing cookies", () => {
  it.each([false, true])("verifies HTTP csrf/origin and signed %s secure-cookie logout", async secure => {
    const f = await fixture(secure); const revoke = vi.fn(async () => {});
    const forwarded = await commitHttpLogout(f.request(), f.config, revoke, {});
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner-a", sessionId: f.sessionId, sessionVersion: 1 }));
    expect(await forwarded.text()).toBe("csrfToken=synthetic-csrf");
  });
  it("preserves secret rotation and chunked secure cookies", async () => {
    const f = await fixture(true, ["new-secret".repeat(8), secret], true); const revoke = vi.fn(async () => {});
    await commitHttpLogout(f.request(), f.config, revoke, {}); expect(revoke).toHaveBeenCalledTimes(1);
  });
  it("blocks forged/cross-origin/missing csrf before any revocation", async () => {
    const f = await fixture(); const revoke = vi.fn(async () => {});
    for (const change of [{ origin: "https://evil.example" }, { "content-type": "application/json" }, { cookie: f.cookie.replace("synthetic-csrf", "forged") }]) {
      const req = f.request(); const headers = new Headers(req.headers); for (const [k, v] of Object.entries(change)) headers.set(k, v);
      await expect(commitHttpLogout(new Request(req, { headers }), f.config, revoke, {})).rejects.toThrow();
    }
    expect(revoke).not.toHaveBeenCalled();
  });
  it("server-action path commits the original verified cookie before signOut; revoked sessions need no auth() call", async () => {
    const f = await fixture(); const revoke = vi.fn(async () => {});
    await commitServerLogout(new Headers({ cookie: f.cookie }), f.config, revoke, { AUTH_URL: f.base }); expect(revoke).toHaveBeenCalledTimes(1);
  });
  it("both paths reject decode/database failures instead of delegating cookie clearing", async () => {
    const f = await fixture(); const revoke = vi.fn(async () => { throw new Error("synthetic DB outage"); });
    await expect(commitHttpLogout(f.request(), f.config, revoke, {})).rejects.toThrow("synthetic DB outage");
    await expect(commitServerLogout(new Headers({ cookie: f.cookie }), f.config, revoke, { AUTH_URL: f.base })).rejects.toThrow("synthetic DB outage");
    const request = f.request(); const headers = new Headers(request.headers); headers.set("cookie", f.cookie.replace(/authjs.session-token=[^;]+/, "authjs.session-token=bad-token"));
    await expect(commitHttpLogout(new Request(request, { headers }), f.config, revoke, {})).rejects.toThrow();
  });
});
