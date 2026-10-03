import { describe, expect, it } from "vitest";
import { capResult, cleanDescription, mcpResultToModelOutput, MAX_DESCRIPTION_CHARS, stripHidden } from "@/lib/mcp/hygiene";

const TAGS = "\u{E0049}\u{E0067}\u{E006E}\u{E006F}\u{E0072}\u{E0065}"; // "Ignore" in Unicode tag characters

describe("MCP text cleaning", () => {
  it("strips characters that hide text from reviewers, and keeps normal text and emoji", () => {
    expect(stripHidden(`Look up${TAGS} a user`)).toBe("Look up a user");
    expect(stripHidden("a\u202Eb\u2066c\u200Bd\uFEFFe")).toBe("abcde");
    expect(stripHidden("x\u{E0101}y")).toBe("xy");
    const family = "👨\u200D👩\u200D👧";
    expect(stripHidden(`${family} ❤️ café`)).toBe(`${family} ❤️ café`);
  });

  it("caps descriptions", () => {
    expect(cleanDescription(` ${"a".repeat(MAX_DESCRIPTION_CHARS + 10)} `)).toHaveLength(MAX_DESCRIPTION_CHARS + 1);
    expect(cleanDescription(undefined)).toBeUndefined();
  });
});

describe("MCP result limit", () => {
  it("passes small results through, cleaned", () => {
    expect(capResult({ content: [{ type: "text", text: `ok${TAGS}` }] }, 1000)).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  it("cuts long text with a note and drops the parts after it", () => {
    const r = capResult({ content: [{ type: "text", text: "x".repeat(5000) }, { type: "text", text: "more" }] }, 2048);
    expect(r.content![0].text).toHaveLength(2048);
    expect(r.content![1].text).toMatch(/Truncated: the result was longer than 2 KB; 1 more part\(s\) omitted/);
    expect(r.content).toHaveLength(2);
  });

  it("replaces images that don't fit, keeps the error flag, and drops structured content when content exists", () => {
    const r = capResult({ isError: true, structuredContent: { a: 1 }, content: [{ type: "image", data: "A".repeat(3000), mimeType: "image/png" }] }, 1024);
    expect(r).toEqual({ isError: true, content: [{ type: "text", text: expect.stringMatching(/Image omitted/) }] });
  });

  it("keeps structured-only results within the budget, and cuts ones that aren't", () => {
    expect(capResult({ content: [], structuredContent: { a: 1 } }, 100)).toEqual({ content: [], structuredContent: { a: 1 } });
    expect(capResult({ content: [], structuredContent: { a: "x".repeat(500) } }, 100).content![0].text).toMatch(/Truncated/);
    expect(capResult({ toolResult: "y".repeat(500) } as never, 100).content![0].text).toMatch(/Truncated/);
  });

  it("maps results for the model like @ai-sdk/mcp does", () => {
    expect(
      mcpResultToModelOutput({
        output: { content: [{ type: "text", text: "hi" }, { type: "image", data: "AAAA", mimeType: "image/png" }, { type: "resource_link", uri: "x://y" }] },
      }),
    ).toEqual({
      type: "content",
      value: [
        { type: "text", text: "hi" },
        { type: "file", mediaType: "image/png", data: { type: "data", data: "AAAA" } },
        { type: "text", text: JSON.stringify({ type: "resource_link", uri: "x://y" }) },
      ],
    });
    expect(mcpResultToModelOutput({ output: { content: [], structuredContent: { a: 1 } } })).toEqual({ type: "json", value: { a: 1 } });
  });
});
