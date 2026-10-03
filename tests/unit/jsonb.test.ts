import { describe, expect, it } from "vitest";
import { jsonbSafe } from "@/lib/jsonb";

describe("jsonbSafe", () => {
  it("replaces NUL and lone surrogates everywhere in a JSON value, which Postgres jsonb refuses", () => {
    const v = { a: "x\u0000y", list: ["ok", "bad\ud800", { "k\u0000": 1 }], n: 3, b: true, nil: null };
    expect(jsonbSafe(v)).toEqual({ a: "x�y", list: ["ok", "bad�", { "k�": 1 }], n: 3, b: true, nil: null });
    expect(() => JSON.parse(JSON.stringify(jsonbSafe(v)))).not.toThrow();
  });

  it("returns the same objects when nothing needs changing (no copies on the hot path)", () => {
    const inner = { text: "hello", deep: ["a", 1] };
    const v = { inner, list: [inner] };
    expect(jsonbSafe(v)).toBe(v);
    const changed = jsonbSafe({ keep: inner, fix: "\u0000" });
    expect(changed.keep).toBe(inner);
  });

  it("leaves well-formed surrogate pairs (emoji) alone", () => {
    expect(jsonbSafe("ok 😀")).toBe("ok 😀");
  });
});
