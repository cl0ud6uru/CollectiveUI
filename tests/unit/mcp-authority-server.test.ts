import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@/db/schema";

vi.mock("server-only", () => ({}));
vi.mock("@/db", () => ({ db: {} }));

import { authorityServer } from "@/lib/mcp/authorization";
import { canonicalJson } from "@/lib/mcp/snapshot";

const server = {
  id: "srv", name: "Fixture", url: "https://mcp.example.test/", transport: "http", headersEnc: "v2.k1.secret",
  status: "enabled", trust: "trusted", toolsHash: "hash-a", toolsDrift: null, toolPolicy: {}, policyRevision: 3,
  serverInfo: { name: "fixture", version: "1.0.0" }, lastTestedAt: new Date("2026-11-01T00:00:00Z"), lastError: null,
} as unknown as McpServer;
const bound = (s: McpServer) => canonicalJson(authorityServer(s));

describe("MCP authority binding server fields", () => {
  it("ignores refresh bookkeeping", () => {
    expect(bound({ ...server, lastError: "connect ETIMEDOUT", lastTestedAt: new Date("2026-11-02T00:00:00Z") })).toBe(bound(server));
    expect(bound({ ...server, serverInfo: { name: "fixture", version: "1.0.1" } })).toBe(bound(server));
  });

  it.each([
    ["endpoint", { url: "https://other.example.test/" }],
    ["credentials", { headersEnc: "v2.k1.other" }],
    ["trust", { trust: "untrusted" }],
    ["status", { status: "needs_review" }],
    ["accepted tools", { toolsHash: "hash-b" }],
    ["tool drift", { toolsDrift: { added: ["new_tool"] } }],
    ["policy revision", { policyRevision: 4 }],
  ])("still binds the %s", (_label, change) => {
    expect(bound({ ...server, ...change } as unknown as McpServer)).not.toBe(bound(server));
  });
});
