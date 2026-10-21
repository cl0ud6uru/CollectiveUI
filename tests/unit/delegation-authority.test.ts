import { describe, expect, it } from "vitest";
import type { Principal } from "@/lib/auth/groups";
import { authorityOf } from "@/lib/delegation/authority";

const principal = (over: Partial<Principal["user"]> = {}, rest: Partial<Omit<Principal, "user">> = {}): Principal => ({
  user: {
    id: "u1", upn: "u1@example.test", identityRealm: "directory", sessionVersion: 3, authChangedAt: null, email: "u1@example.test",
    name: "User One", authSource: "ldap", isAdmin: false, disabled: false, prefs: { memoryEnabled: true }, createdAt: new Date(0), lastLoginAt: new Date(0),
    ...over,
  },
  groupIds: ["g2", "g1"], isAdmin: false, canCreateBots: true, ...rest,
});

describe("delegated authority binding", () => {
  it("ignores sidebar navigation and sign-in bookkeeping", () => {
    const before = authorityOf(principal());
    expect(authorityOf(principal({ prefs: { memoryEnabled: true, botOrder: ["b"], botLastSentAt: { b: "2026-01-01T00:00:00Z" } } }))).toEqual(before);
    expect(authorityOf(principal({ lastLoginAt: new Date() }))).toEqual(before);
    expect(authorityOf(principal({}, { groupIds: ["g1", "g2"] }))).toEqual(before);
  });

  it("changes with access, session and agent-facing preferences", () => {
    const before = authorityOf(principal());
    for (const changed of [
      principal({ sessionVersion: 4 }), principal({ disabled: true }), principal({}, { isAdmin: true }), principal({}, { groupIds: ["g1"] }),
      principal({ prefs: { memoryEnabled: false } }), principal({ prefs: { memoryEnabled: true, customInstructions: "x" } }),
    ]) expect(authorityOf(changed)).not.toEqual(before);
  });
});
