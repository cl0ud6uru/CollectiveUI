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
  it("prefixes the server, keeps to what model APIs accept, and never collides", () => {
    const taken = new Set<string>();
    expect(modelToolName({ name: "Jira Cloud" }, "issues.search", taken)).toBe("jira_cloud__issues_search");
    expect(modelToolName({ name: "Jira Cloud" }, "issues/search", taken)).toBe("jira_cloud__issues_search_2");
    const long = modelToolName({ name: "x".repeat(60) }, "y".repeat(60), taken);
    expect(long).toHaveLength(64);
    expect(modelToolName({ name: "x".repeat(60) }, "y".repeat(60), taken)).toMatch(/_2$/);
    expect(modelToolName({ name: "!!!" }, "t", taken)).toBe("mcp__t");
  });
});
