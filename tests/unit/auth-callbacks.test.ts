import type { NextAuthConfig } from "next-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
const captured = vi.hoisted(() => ({ config: null as NextAuthConfig | null }));
const mocks = vi.hoisted(() => ({ sync: vi.fn(), save: vi.fn(), groups: vi.fn(), state: vi.fn() }));
vi.mock("next-auth", () => {
  return { CredentialsSignin: class extends Error {}, default: (config: NextAuthConfig) => { captured.config = config; return {}; } };
});
vi.mock("@/lib/auth/groups", () => ({ syncUserOnSignIn: mocks.sync }));
vi.mock("@/lib/auth/entra", () => ({ fetchEntraGroupsViaGraph: mocks.groups, saveEntraTokens: mocks.save }));
vi.mock("@/lib/auth/session-state", async original => ({ ...await original<object>(), sessionState: mocks.state }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
async function config() {
  vi.resetModules();
  vi.stubEnv("AUTH_ENTRA_ENABLED", "true"); vi.stubEnv("AUTH_MICROSOFT_ENTRA_ID_ID", "synthetic-fixture-client");
  vi.stubEnv("AUTH_LOCAL_ENABLED", "true"); vi.stubEnv("LDAP_ENABLED", "true"); vi.stubEnv("LDAP_URL", "ldap://fixture.invalid");
  mocks.state.mockResolvedValue({ mustChangePassword: false });
  mocks.sync.mockResolvedValue({ id: "directory-id", name: "Directory Fixture", email: "same@example.invalid", sessionVersion: 7, disabled: false });
  mocks.save.mockResolvedValue(undefined); mocks.groups.mockResolvedValue(["fixture-group"]);
  await import("@/auth");
  return captured.config!;
}
describe("Auth.js callback provider regressions", () => {
  it("keeps Entra sync, group overage and token persistence in the directory identity; session exposes no credentials", async () => {
    const c = await config();
    const token = await c.callbacks!.jwt!({ token: {}, user: { id: "oidc-user" }, account: { provider: "microsoft-entra-id", access_token: "synthetic-token" }, profile: { preferred_username: "SAME@example.invalid", name: "Directory Fixture", email: "same@example.invalid", _claim_names: { groups: "source" } } } as never);
    expect(mocks.sync).toHaveBeenCalledWith(expect.objectContaining({ upn: "same@example.invalid", source: "entra", groups: [{ externalId: "fixture-group" }] }));
    expect(mocks.save).toHaveBeenCalledWith("directory-id", expect.objectContaining({ access_token: "synthetic-token" }));
    expect(mocks.state).toHaveBeenCalledWith("directory-id", 7, "microsoft-entra-id");
    const session = await c.callbacks!.session!({ session: { user: {}, expires: "fixture" }, token } as never);
    expect(session.user).toMatchObject({ id: "directory-id", sessionVersion: 7, mustChangePassword: false });
    expect(JSON.stringify(session)).not.toContain("synthetic-token");
  });
  it("binds local credentials to the version read at verification, and restricts temporary sessions", async () => {
    const c = await config(); mocks.state.mockResolvedValue({ mustChangePassword: true });
    const token = await c.callbacks!.jwt!({ token: {}, user: { id: "local-id", sessionVersion: 3 }, account: { provider: "local" } } as never);
    expect(token).toMatchObject({ uid: "local-id", sessionVersion: 3, mustChangePassword: true });
    expect(mocks.sync).not.toHaveBeenCalled();
    mocks.state.mockResolvedValue(null);
    expect(await c.callbacks!.jwt!({ token } as never)).toBeNull();
  });
  it("rejects expired old and new sessions even when Auth.js presents a renewed exp", async () => {
    const c = await config();
    const now = Math.floor(Date.now() / 1000);
    expect(await c.callbacks!.jwt!({ token: { uid: "directory-id", exp: now - 1 } } as never)).toBeNull();
    expect(await c.callbacks!.jwt!({ token: { uid: "directory-id", sessionDeadline: now - 1, exp: now + 43200 } } as never)).toBeNull();
    expect(await c.callbacks!.jwt!({ token: { uid: "directory-id", signedInAt: now - 43201, exp: now + 43200 } } as never)).toBeNull();
  });
});
