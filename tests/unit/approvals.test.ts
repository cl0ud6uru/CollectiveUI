import { describe, expect, it } from "vitest";
import { resolveApproval } from "@/lib/agent/approvals";

const base = { toolName: "fetch_url", toolKey: "fetch_url", mode: "auto" as const, sensitive: false, enforced: [], grants: new Set<string>() };

describe("resolveApproval", () => {
  it("runs auto tools without approval", () => {
    expect(resolveApproval(base)).toBeUndefined();
  });
  it("asks for 'ask' tools", () => {
    expect(resolveApproval({ ...base, mode: "ask" })).toBe("user-approval");
  });
  it("respects the user's 'always allow' grant", () => {
    expect(resolveApproval({ ...base, mode: "ask", grants: new Set(["fetch_url"]) })).toBeUndefined();
  });
  it("treats sensitive tools as 'ask' even when configured auto", () => {
    expect(resolveApproval({ ...base, sensitive: true })).toBe("user-approval");
  });
  it("admin enforcement beats user grants (by name)", () => {
    expect(resolveApproval({ ...base, mode: "ask", enforced: ["fetch_url"], grants: new Set(["fetch_url"]) })).toBe("user-approval");
  });
  it("admin enforcement works by tool group key", () => {
    expect(resolveApproval({ ...base, toolName: "jira__create", toolKey: "mcp:abc", enforced: ["mcp:abc"] })).toBe("user-approval");
  });
});

describe("resolveApproval for MCP tools", () => {
  const mcpBase = { ...base, toolName: "jira__get_issue", toolKey: "mcp:jira", mode: "smart" as const };
  const facts = (over: Partial<NonNullable<Parameters<typeof resolveApproval>[0]["mcp"]>> = {}) => ({
    readOnly: false,
    destructive: false,
    trusted: false,
    requireApproval: false,
    ...over,
  });

  it("smart runs read-only tools of a trusted server without asking", () => {
    expect(resolveApproval({ ...mcpBase, mcp: facts({ readOnly: true, trusted: true }) })).toBeUndefined();
  });

  it("smart asks when the server isn't trusted, the tool isn't read-only, or it is also destructive", () => {
    expect(resolveApproval({ ...mcpBase, mcp: facts({ readOnly: true }) })).toBe("user-approval");
    expect(resolveApproval({ ...mcpBase, mcp: facts({ trusted: true }) })).toBe("user-approval");
    expect(resolveApproval({ ...mcpBase, mcp: facts({ trusted: true, readOnly: true, destructive: true }) })).toBe("user-approval");
  });

  it("the user's 'always allow' covers smart's ask", () => {
    expect(resolveApproval({ ...mcpBase, grants: new Set(["jira__get_issue"]), mcp: facts() })).toBeUndefined();
  });

  it("the bot's per-tool override beats the server's mode", () => {
    expect(resolveApproval({ ...mcpBase, mode: "ask", mcp: facts({ override: "auto" }) })).toBeUndefined();
    expect(resolveApproval({ ...mcpBase, mode: "auto", mcp: facts({ override: "ask" }) })).toBe("user-approval");
    expect(resolveApproval({ ...mcpBase, mode: "auto", mcp: facts({ override: "smart", trusted: true, readOnly: true }) })).toBeUndefined();
  });

  it("an admin's 'require approval' always asks, even over overrides and grants", () => {
    const i = { ...mcpBase, mode: "auto" as const, grants: new Set(["jira__get_issue"]), mcp: facts({ requireApproval: true, override: "auto", trusted: true, readOnly: true }) };
    expect(resolveApproval(i)).toBe("user-approval");
  });

  it("the org-wide enforced list still applies", () => {
    expect(resolveApproval({ ...mcpBase, enforced: ["mcp:jira"], mcp: facts({ trusted: true, readOnly: true }) })).toBe("user-approval");
  });

  it("smart on a built-in tool behaves like auto (sensitive ones still ask)", () => {
    expect(resolveApproval({ ...base, mode: "smart" })).toBeUndefined();
    expect(resolveApproval({ ...base, mode: "smart", sensitive: true })).toBe("user-approval");
  });
});
