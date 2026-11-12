import { describe, expect, it } from "vitest";
import { modelToolName } from "@/lib/agent/tools/mcp";
import { offeredTools } from "@/lib/mcp/servers";
import { canonicalJson, diffTools, snapshotHash, toolHash, toToolDef } from "@/lib/mcp/snapshot";

const def = (name: string, over: object = {}) => toToolDef({ name, description: `${name} tool`, inputSchema: { type: "object", properties: {} }, ...over })!;

describe("MCP tool snapshots", () => {
  it("keeps only the fields the portal uses", () => {
    expect(
      toToolDef({
        name: "get",
        title: "Get",
        description: "d",
        inputSchema: { properties: { id: { type: "string" } } },
        annotations: { readOnlyHint: true, somethingNew: 1 },
        _meta: { big: "x".repeat(1000) },
        icons: [],
      }),
    ).toEqual({ name: "get", title: "Get", description: "d", inputSchema: { type: "object", properties: { id: { type: "string" } } }, annotations: { readOnlyHint: true } });
    expect(toToolDef({ description: "no name" })).toBeNull();
  });

  it("hashes don't depend on key or tool order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
    expect(snapshotHash([def("a"), def("b")])).toBe(snapshotHash([def("b"), def("a")]));
  });

  it("a changed description or annotation counts as a change, not only a changed signature", () => {
    const before = [def("echo", { annotations: { readOnlyHint: true } }), def("gone")];
    const after = [def("echo", { annotations: { readOnlyHint: false } }), def("new")];
    expect(diffTools(before, after)).toEqual({ added: ["new"], changed: ["echo"], removed: ["gone"] });
    expect(toolHash(def("x", { description: "Look up a user" }))).not.toBe(toolHash(def("x", { description: "Look up a user and email them" })));
  });

  it("bots see accepted tools, minus ones turned off or waiting for review", () => {
    const tools = [def("a"), def("b"), def("c"), def("d")];
    const drift = { detectedAt: "", hash: "h", tools: [], added: ["e"], changed: ["b"], removed: ["c"] };
    expect(offeredTools({ toolsSnapshot: tools, toolsDrift: drift, toolPolicy: { d: { enabled: false } } }).map((t) => t.name)).toEqual(["a"]);
    expect(offeredTools({ toolsSnapshot: null, toolsDrift: null, toolPolicy: {} })).toEqual([]);
  });
});

describe("model-facing MCP tool names", () => {
  it("binds names to the exact server and raw tool within provider limits", () => {
    const server = { id: "jira", name: "Jira Cloud" }, taken = new Set<string>();
    const names = ["issues.search", "issues/search", "issues_search", "x".repeat(100) + "a", "x".repeat(100) + "b"]
      .map(tool => modelToolName(server, tool, taken));
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^mcp__[A-Za-z0-9_-]+__[a-f0-9]{32}$/);
      expect(name.length).toBeLessThanOrEqual(64);
    }
    expect(names[3]).toHaveLength(64);
    expect(modelToolName({ id: "other", name: "Jira Cloud" }, "issues.search", taken)).not.toBe(names[0]);
    // Array serialization prevents a boundary collision between server IDs and tool names.
    expect(modelToolName({ id: "a:b" }, "c", new Set())).not.toBe(modelToolName({ id: "a" }, "b:c", new Set()));
  });

  it("stays stable across display renames, catalog order and neighboring tool removal", () => {
    const before = modelToolName({ id: "a", name: "Old name" }, "issues/search", new Set());
    const taken = new Set<string>();
    modelToolName({ id: "b", name: "New name" }, "issues/search", taken);
    modelToolName({ id: "a", name: "New name" }, "issues.search", taken);
    expect(modelToolName({ id: "a", name: "New name" }, "issues/search", taken)).toBe(before);
    expect(modelToolName({ id: "a" }, "issues/search", new Set())).toBe(before);
  });

  it("rejects duplicate identities instead of assigning a reusable numeric alias", () => {
    const taken = new Set<string>();
    modelToolName({ id: "a" }, "tool", taken);
    expect(() => modelToolName({ id: "a" }, "tool", taken)).toThrow(/Duplicate MCP tool identity/);
  });
});
