import { APICallError, RetryError } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { nativeErrorText } from "@/lib/llm/native-errors";
import { ProviderUnavailableError } from "@/lib/llm/errors";
import { ChatGPTNotConnectedError, ChatGPTUsageLimitError } from "@/lib/llm/chatgpt/errors";
import { McpToolError } from "@/lib/mcp/errors";
const privateText = "arbitrary-fixture-secret https://private.fixture.invalid/request-data";
afterEach(() => vi.restoreAllMocks());
describe("native error boundary", () => {
  it.each([
    new Error(privateText), new McpToolError(privateText), { message: privateText },
    new APICallError({ message: privateText, url: "https://private.fixture.invalid", requestBodyValues: { privateText }, responseBody: privateText, statusCode: 500 }),
  ])("uses a correlated safe fallback and bounded diagnostics for %j", err => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const text = nativeErrorText(err);
    expect(text).toMatch(/^Something went wrong\. Try again\. Reference: [\w-]+\.$/);
    expect(text).not.toContain(privateText);
    const record = log.mock.calls[0][1] as { reference: string };
    expect(text).toContain(record.reference);
    expect(JSON.stringify(log.mock.calls)).not.toContain("arbitrary-fixture-secret");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private.fixture.invalid");
    expect(JSON.stringify(log.mock.calls).length).toBeLessThan(200);
  });
  it("preserves typed connect, quota and provider guidance across retries", () => {
    for (const err of [new ChatGPTNotConnectedError(), new ChatGPTUsageLimitError(null), new ProviderUnavailableError("Choose a configured company model.")]) {
      expect(nativeErrorText(err)).toBe(err.message);
      expect(nativeErrorText(new RetryError({ message: privateText, reason: "maxRetriesExceeded", errors: [err] }))).toBe(err.message);
    }
  });
  it("preserves trusted local approval guidance", () => {
    expect(nativeErrorText(new Error(privateText), "Review the new approval card.")).toBe("Review the new approval card.");
  });
});
