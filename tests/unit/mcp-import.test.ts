import { describe, expect, it } from "vitest";
import { parseMcpConfig, stripJsonComments } from "@/lib/mcp/import";
import { checkMcpUrl, isBlockedAddress } from "@/lib/mcp/url";

describe("importing MCP client configs", () => {
  it("imports remote servers from Claude Code / Cursor configs, with their headers", () => {
    const r = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          jira: { type: "http", url: "https://mcp.internal/jira/mcp", headers: { Authorization: "Bearer abc123" } },
          wiki: { type: "sse", url: "https://mcp.internal/wiki/sse" },
          cursorStyle: { url: "https://mcp.internal/crm/mcp" },
          guessSse: { url: "https://mcp.internal/old/sse" },
          streamable: { type: "streamable-http", url: "https://mcp.internal/s/mcp" },
        },
      }),
    );
    expect(r.rejected).toEqual([]);
    expect(r.candidates.map((c) => [c.name, c.transport])).toEqual([
      ["jira", "http"],
      ["wiki", "sse"],
      ["cursorStyle", "http"],
      ["guessSse", "sse"],
      ["streamable", "http"],
    ]);
    expect(r.candidates[0].headers).toEqual({ Authorization: "Bearer abc123" });
  });

  it("rejects stdio servers with a reason, but unwraps mcp-remote bridges", () => {
    const r = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          files: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
          bridged: { command: "npx", args: ["-y", "mcp-remote@latest", "https://mcp.internal/crm/mcp", "--header", "Authorization: Bearer k-123"] },
          typed: { type: "stdio", command: "python", args: ["server.py"] },
        },
      }),
    );
    expect(r.rejected.map((x) => x.name)).toEqual(["files", "typed"]);
    expect(r.rejected[0].reason).toMatch(/local program/);
    expect(r.candidates).toEqual([
      expect.objectContaining({ name: "bridged", url: "https://mcp.internal/crm/mcp", transport: "http", headers: { Authorization: "Bearer k-123" } }),
    ]);
  });

  it("reads VS Code JSONC (comments, trailing commas, servers key) without touching strings", () => {
    const text = `{
      // VS Code mcp.json
      "servers": {
        "docs": { "type": "http", "url": "https://docs.internal/mcp", /* inline */ "headers": { "X-Key": "a//b,}" }, },
      },
    }`;
    const r = parseMcpConfig(text);
    expect(r.candidates).toEqual([expect.objectContaining({ name: "docs", url: "https://docs.internal/mcp", headers: { "X-Key": "a//b,}" } })]);
    expect(JSON.parse(stripJsonComments('{"a": "http://x", // c\n}'))).toEqual({ a: "http://x" });
  });

  it("never fills in variables: headers that use one are left out with a warning", () => {
    const r = parseMcpConfig(JSON.stringify({ mcpServers: { a: { url: "https://a.internal/mcp", headers: { Authorization: "Bearer ${API_KEY}", "X-Team": "ops" } } } }));
    expect(r.candidates[0].headers).toEqual({ "X-Team": "ops" });
    expect(r.candidates[0].warnings.join(" ")).toMatch(/Authorization.*variable/);
    expect(parseMcpConfig(JSON.stringify({ mcpServers: { b: { url: "https://${HOST}/mcp" } } })).rejected[0].reason).toMatch(/variable/);
  });

  it("accepts a bare map of servers and explains what it can't read", () => {
    expect(parseMcpConfig(JSON.stringify({ a: { url: "https://a.internal/mcp" } })).candidates).toHaveLength(1);
    expect(() => parseMcpConfig("not json")).toThrow(/valid JSON/);
    expect(() => parseMcpConfig(JSON.stringify({ foo: 1 }))).toThrow(/No MCP servers/);
    expect(parseMcpConfig(JSON.stringify({ mcpServers: { x: { type: "websocket", url: "https://x/mcp" } } })).rejected[0].reason).toMatch(/Unknown transport/);
  });
});

describe("MCP server URL check", () => {
  const resolvesTo = (...addresses: string[]) => async () => addresses.map((address) => ({ address }));

  it("allows internal servers, and https anywhere", async () => {
    expect(await checkMcpUrl("http://mcp.internal:4020/mcp", resolvesTo("10.1.2.3"))).toBeNull();
    expect(await checkMcpUrl("http://localhost:4020/mcp", resolvesTo("127.0.0.1"))).toBeNull();
    expect(await checkMcpUrl("https://mcp.example.com/mcp", resolvesTo("93.184.216.34"))).toBeNull();
  });

  it("blocks metadata and link-local addresses, credentials in the URL, and cleartext to public hosts", async () => {
    expect(await checkMcpUrl("http://169.254.169.254/latest")).toMatch(/metadata/);
    expect(await checkMcpUrl("https://evil.example/mcp", resolvesTo("169.254.169.254"))).toMatch(/metadata/);
    expect(await checkMcpUrl("http://[fe80::1]/mcp")).toMatch(/metadata/);
    expect(await checkMcpUrl("https://user:pw@mcp.internal/mcp", resolvesTo("10.0.0.1"))).toMatch(/header/);
    expect(await checkMcpUrl("http://mcp.example.com/mcp", resolvesTo("93.184.216.34"))).toMatch(/https/);
    expect(await checkMcpUrl("ftp://x/mcp")).toMatch(/http/);
    expect(await checkMcpUrl("::")).toMatch(/valid URL/);
  });

  it("leaves hosts that don't resolve to the connection test", async () => {
    expect(await checkMcpUrl("https://nowhere.invalid/mcp", async () => Promise.reject(new Error("ENOTFOUND")))).toBeNull();
  });

  it("classifies blocked addresses", () => {
    for (const ip of ["169.254.1.1", "0.0.0.0", "224.0.0.1", "::", "fe80::1", "ff02::1", "fd00:ec2::254", "::ffff:169.254.169.254", "100.100.100.200"])
      expect(isBlockedAddress(ip), ip).toBe(true);
    for (const ip of ["10.0.0.1", "127.0.0.1", "192.168.1.1", "8.8.8.8", "::1", "fd12::1"]) expect(isBlockedAddress(ip), ip).toBe(false);
  });
});
