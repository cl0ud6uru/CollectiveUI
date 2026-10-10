import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ origin: vi.fn(), password: vi.fn(), passkey: vi.fn(), consume: vi.fn(), actor: vi.fn(), summary: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn() }) }));
vi.mock("@/lib/auth/throttle", () => ({ allowSecurityRequest: async () => true }));
vi.mock("@/lib/session", () => ({ requireSecurityActor: fixture.actor }));
vi.mock("@/lib/auth/security", () => ({ beginPasswordLogin: fixture.password, finishPasswordLogin: fixture.consume,
  beginPasskey: vi.fn(), finishPasskey: fixture.passkey, reauthenticatePassword: fixture.password,
  beginRegistration: vi.fn(), finishRegistration: vi.fn(), beginTotp: vi.fn(), finishTotp: vi.fn(), manageSecurity: vi.fn(), securitySummary: fixture.summary }));
vi.mock("@/lib/auth/factors", () => ({ assertSecurityOrigin: fixture.origin, SECURITY_ERROR: "Unable to verify. Start again.",
  SecurityError: class extends Error {}, bindingCookieName: () => "synthetic-binding", readBinding: () => "synthetic-binding",
  securityConfig: () => ({ secure: false }) }));
import { POST as login } from "@/app/api/auth/ldap-security/route";
import { GET as summary, POST as account } from "@/app/api/account/security/route";
import { LdapUnavailableError } from "@/lib/auth/ldap";
import { SecurityError } from "@/lib/auth/factors";
import { securityPost, securityErrorMessage } from "@/lib/auth/security-client";

beforeEach(() => { vi.resetAllMocks(); vi.spyOn(console, "warn").mockImplementation(() => {}); fixture.actor.mockResolvedValue({ user: { id: "synthetic-user" } }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const request = (action: string) => new Request("https://fixture.invalid/api/auth/ldap-security", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, username: "alice", password: "synthetic-only" }),
});

it.each(["password-begin", "password-finish", "passkey-finish"])("returns the same safe 503 for %s directory failures", async action => {
  const unavailable = new LdapUnavailableError(Object.assign(new Error("synthetic-only alice@fixture.invalid"), { code: "ECONNRESET" }), "account_status");
  fixture.password.mockRejectedValue(unavailable); fixture.passkey.mockRejectedValue(unavailable); fixture.consume.mockRejectedValue(unavailable);
  const response = await login(request(action));
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ error: "Unable to verify. Start again.", code: "directory_unavailable" });
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/synthetic-only|alice@/);
});

it("keeps invalid credentials and invalid-origin requests generic", async () => {
  fixture.password.mockRejectedValue(new SecurityError());
  expect((await login(request("password-begin"))).status).toBe(400);
  fixture.password.mockClear(); fixture.origin.mockImplementation(() => { throw new SecurityError(); });
  const response = await login(request("password-begin"));
  expect(await response.json()).toEqual({ error: "Unable to verify. Start again." });
  expect(fixture.password).not.toHaveBeenCalled();
});

it("reports safe outage feedback for authenticated security reads and reauthentication", async () => {
  const unavailable = new LdapUnavailableError(new Error("private detail"));
  fixture.summary.mockRejectedValue(unavailable); fixture.password.mockRejectedValue(unavailable);
  expect((await summary()).status).toBe(503);
  expect((await account(request("reauth-password"))).status).toBe(503);
  fixture.actor.mockRejectedValue(new SecurityError());
  expect((await account(request("reauth-password"))).status).toBe(400);
});

it("preserves the outage code/message for client password, passkey and ticket handling without a fetch", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "generic", code: "directory_unavailable" }, { status: 503 })));
  await expect(securityPost("/api/auth/ldap-security", { action: "password-begin" })).rejects.toMatchObject({ code: "directory_unavailable", message: expect.stringContaining("company directory") });
  expect(securityErrorMessage({ code: "directory_unavailable" }, "passkey fallback")).toContain("company directory");
  expect(securityErrorMessage(Object.assign(new Error("ticket"), { code: "directory_unavailable" }), "ticket fallback")).toContain("company directory");
  for (const error of [null, undefined, "directory_unavailable", { code: "invalid_credentials" }]) expect(securityErrorMessage(error, "generic")).toBe("generic");
});
