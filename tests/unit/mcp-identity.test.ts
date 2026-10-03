import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  identityClaims,
  IDENTITY_TTL_SEC,
  newIdentitySecret,
  openIdentitySecret,
  sealIdentitySecret,
  signIdentity,
  SYSTEM_SUBJECT,
  validIdentityHeader,
} from "@/lib/mcp/identity";

const user = { kind: "user" as const, id: "u1", upn: "alice@corp.local", email: "alice@corp.local", name: "Alice", groups: ["Engineering"] };
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());

describe("MCP identity tokens", () => {
  it("carries who is calling, for this server, for 60 seconds", () => {
    const now = Date.UTC(2026, 0, 1);
    const c = identityClaims(user, { audience: "https://mcp.internal/jira/mcp", botId: "b1", conversationId: "c1", now });
    expect(c).toMatchObject({
      iss: "ai-portal",
      aud: "https://mcp.internal/jira/mcp",
      sub: "u1",
      upn: "alice@corp.local",
      email: "alice@corp.local",
      name: "Alice",
      groups: ["Engineering"],
      bot: "b1",
      conv: "c1",
      iat: now / 1000,
      exp: now / 1000 + IDENTITY_TTL_SEC,
    });
    expect(c.jti).toMatch(/^[\w-]{16}$/);
    expect(identityClaims(user, { audience: "x" }).jti).not.toBe(c.jti);
  });

  it("the portal's own calls (tool listing) say so, with no person in them", () => {
    const c = identityClaims({ kind: "system" }, { audience: "https://x/mcp" });
    expect(c.sub).toBe(SYSTEM_SUBJECT);
    expect(c.system).toBe(true);
    expect(c).not.toHaveProperty("upn");
  });

  it("is an HS256 JWT keyed by the secret string", () => {
    const secret = newIdentitySecret();
    expect(Buffer.from(secret, "base64url")).toHaveLength(32);
    const token = signIdentity(identityClaims(user, { audience: "https://x/mcp" }), secret);
    const [h, p, sig] = token.split(".");
    expect(decode(h)).toEqual({ alg: "HS256", typ: "JWT" });
    expect(decode(p).upn).toBe("alice@corp.local");
    expect(sig).toBe(createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url"));
    expect(signIdentity(decode(p), "another-secret").split(".")[2]).not.toBe(sig);
  });

  it("stores the secret bound to its server row", () => {
    const sealed = sealIdentitySecret("srv-1", "s3cret");
    expect(openIdentitySecret({ id: "srv-1", identitySecretEnc: sealed })).toBe("s3cret");
    expect(() => openIdentitySecret({ id: "srv-2", identitySecretEnc: sealed })).toThrow();
    expect(openIdentitySecret({ id: "srv-1", identitySecretEnc: null })).toBeNull();
  });

  it("only allows plain header names the transport doesn't own", () => {
    expect(validIdentityHeader("X-Portal-Identity")).toBe(true);
    expect(validIdentityHeader("X-User-Token")).toBe(true);
    for (const bad of ["Authorization", "cookie", "Mcp-Session-Id", "X Portal", "X-Portal:1", "", "-x"]) expect(validIdentityHeader(bad), bad).toBe(false);
  });
});
