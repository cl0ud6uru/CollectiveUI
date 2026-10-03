import { describe, expect, it } from "vitest";
import { parseHeadersInput, parseSecretInput } from "@/lib/secret-input";

describe("write-only secret inputs", () => {
  it("blank keeps, __clear__ clears, anything else sets", () => {
    expect(parseSecretInput(undefined)).toEqual({ action: "keep" });
    expect(parseSecretInput("   ")).toEqual({ action: "keep" });
    expect(parseSecretInput("__clear__")).toEqual({ action: "clear" });
    expect(parseSecretInput(" sk-abc ")).toEqual({ action: "set", value: "sk-abc" });
  });

  it("MCP headers: __clear__ is recognised before JSON parsing", () => {
    // Regression: "__clear__" used to reach JSON.parse and throw, so stored headers could never be removed.
    expect(parseHeadersInput("__clear__")).toEqual({ action: "clear" });
    expect(parseHeadersInput("")).toEqual({ action: "keep" });
    expect(parseHeadersInput('{"Authorization":"Bearer x"}')).toEqual({ action: "set", headers: { Authorization: "Bearer x" } });
  });

  it("MCP headers: rejects non-JSON and non-string values", () => {
    expect(() => parseHeadersInput("Authorization: Bearer x")).toThrow(/JSON object/);
    expect(() => parseHeadersInput('{"X-Retries": 3}')).toThrow();
  });
});
