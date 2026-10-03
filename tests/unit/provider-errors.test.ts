import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { describeProviderError } from "@/lib/llm/errors";
import { csvCell } from "@/lib/usage";

const apiError = (statusCode: number | undefined, message = "boom") =>
  new APICallError({ message, url: "https://x", requestBodyValues: { secret: "sk-proj-SHOULDNOTAPPEAR000000" }, statusCode, responseBody: "raw body" });

describe("describeProviderError", () => {
  it.each([
    [401, /Authentication failed/],
    [403, /Authentication failed/],
    [404, /Not found/],
    [429, /Rate limited/],
  ])("maps %s", (status, re) => {
    expect(describeProviderError(apiError(status))).toMatch(re);
  });

  it("unwraps retries, handles network errors, redacts and truncates", () => {
    const retry = new RetryError({ message: "retries", reason: "maxRetriesExceeded", errors: [apiError(500), apiError(429)] });
    expect(describeProviderError(retry)).toMatch(/Rate limited/);
    expect(describeProviderError(apiError(undefined, "Cannot connect to API: ECONNREFUSED"))).toMatch(/Can't reach/);
    const msg = describeProviderError(apiError(500, "bad key sk-proj-abcdefghijklmnopqrstuvwxyz " + "x".repeat(500)));
    expect(msg).not.toContain("sk-proj-abcdef");
    expect(msg.length).toBeLessThanOrEqual(300);
    expect(describeProviderError(apiError(500))).not.toContain("SHOULDNOTAPPEAR");
  });
});

describe("usage CSV cells", () => {
  it("quotes values and neutralizes formulas", () => {
    expect(csvCell('a "b"')).toBe('"a ""b"""');
    expect(csvCell("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
    expect(csvCell("+1")).toBe(`"'+1"`);
    expect(csvCell("@x")).toBe(`"'@x"`);
    expect(csvCell(42)).toBe('"42"');
    expect(csvCell(null)).toBe('""');
  });
});
