import { describe, expect, it } from "vitest";
import { latestLeaf, pathTo, partsToText } from "@/lib/chat/store";

const rows = [
  { id: "u1", parentId: null, createdAt: new Date(1) },
  { id: "a1", parentId: "u1", createdAt: new Date(2) },
  { id: "a1b", parentId: "u1", createdAt: new Date(3) }, // regenerated reply
  { id: "u2", parentId: "a1", createdAt: new Date(4) },
  { id: "u2b", parentId: "a1", createdAt: new Date(5) }, // edited question
  { id: "a2", parentId: "u2b", createdAt: new Date(6) },
];

describe("conversation tree", () => {
  it("walks from root to a leaf", () => {
    expect(pathTo(rows, "a2").map((r) => r.id)).toEqual(["u1", "a1", "u2b", "a2"]);
  });
  it("returns an empty path for null leaf", () => {
    expect(pathTo(rows, null)).toEqual([]);
  });
  it("follows the most recent branch", () => {
    expect(latestLeaf(rows, "u1")).toBe("a1b");
    expect(latestLeaf(rows, "a1")).toBe("a2");
  });
  it("is safe against cycles", () => {
    const cyc = [
      { id: "x", parentId: "y" },
      { id: "y", parentId: "x" },
    ];
    expect(pathTo(cyc, "x").length).toBe(2);
  });
  it("extracts searchable text", () => {
    expect(partsToText([{ type: "text", text: "hello" }, { type: "file", filename: "a.pdf" }, { type: "tool-x" }])).toBe("hello\n[a.pdf]");
  });
});
