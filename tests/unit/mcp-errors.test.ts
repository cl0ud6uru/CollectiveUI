import { APICallError, RetryError, convertToModelMessages, isStepCount, streamText, toUIMessageStream } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@/db/schema";
import { mcpTools } from "@/lib/agent/tools/mcp";
import { AAD, encrypt } from "@/lib/crypto";
import { userFacingMessage } from "@/lib/llm/chatgpt/errors";
import { McpToolError } from "@/lib/mcp/errors";
import { sealIdentitySecret } from "@/lib/mcp/identity";
import { finishPart, reduce, text } from "./helpers/run-streams";

const connectMcp = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mcp/client", async (original) => ({
  ...(await original<typeof import("@/lib/mcp/client")>()), connectMcp,
}));

// All server names, messages, and credentials below are synthetic test fixtures.
const apiKey = "fixture-api-secret";
const identityKey = "fixture-identity-secret";
const server = {
  id: "example-mcp", name: "Example MCP", timeoutMs: 12_345, resultBudgetKb: 64,
  trust: "trusted", toolPolicy: {}, toolsDrift: null,
  toolsSnapshot: [{ name: "get_status", inputSchema: { type: "object", properties: {} } }],
  headersEnc: encrypt(JSON.stringify({ Authorization: `Bearer ${apiKey}` }), AAD.mcpHeaders),
  identitySecretEnc: sealIdentitySecret("example-mcp", identityKey),
} as McpServer;

function toolset(overrides: Partial<McpServer> = {}) {
  return mcpTools({ ...server, ...overrides }, {
    caller: { subject: { kind: "user", id: "u1", upn: "alice@example.com", email: null, name: "Alice", groups: [] } },
    config: null, taken: new Set(),
  });
}

function client(failure: Error) {
  const c = { toolsFromDefinitions: vi.fn(), callTool: vi.fn().mockRejectedValue(failure), close: vi.fn(async () => {}) };
  connectMcp.mockResolvedValue(c);
  return c;
}

async function invoke(ts: ReturnType<typeof toolset>, abortSignal?: AbortSignal) {
  return ts.entries[0].tool.execute!({}, { toolCallId: "call-1", messages: [], context: undefined, abortSignal });
}

describe("MCP invocation errors", () => {
  beforeEach(() => { connectMcp.mockReset(); });

  it.each(["Request timed out after 12345ms", "HTTP 401 Unauthorized", "HTTP 429 Too Many Requests"])(
    "preserves the sanitized failure: %s", async (message) => {
      client(new Error(message));
      const ts = toolset();
      try {
        const error = await invoke(ts).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(McpToolError);
        expect(userFacingMessage(error)).toBe(`get_status on "Example MCP" failed: ${message}`);
      } finally { await ts.close(); }
    },
  );

  it("redacts configured credentials and token patterns from the entire message, including server names", async () => {
    client(new Error(`${apiKey} ${identityKey} sk-proj-abcdefghijklmnopqrstuvwxyz`));
    const ts = toolset({ name: `Example MCP ${apiKey}` });
    try {
      const error = await invoke(ts).catch((e: unknown) => e);
      const message = userFacingMessage(error)!;
      expect(message).toContain("[redacted]");
      for (const secret of [apiKey, identityKey, "sk-proj-abcdefghijklmnopqrstuvwxyz"]) expect(message).not.toContain(secret);
      expect((error as Error).cause).toBeUndefined();
    } finally { await ts.close(); }
  });

  it("preserves sanitized connection failures and caps long upstream messages", async () => {
    connectMcp.mockRejectedValue(new Error(`Connection refused ${apiKey} ${"x".repeat(1000)}`));
    const ts = toolset();
    try {
      const error = await invoke(ts).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(McpToolError);
      expect(userFacingMessage(error)).toMatch(/"Example MCP" is unavailable right now: Connection refused \[redacted\]/);
      expect(userFacingMessage(error)!.length).toBeLessThanOrEqual(500);
    } finally { await ts.close(); }
  });

  it("keeps cancellation as cancellation rather than a user-facing MCP failure", async () => {
    const failure = new Error("cancelled");
    client(failure);
    const ts = toolset();
    try {
      await expect(invoke(ts, AbortSignal.abort())).rejects.toBe(failure);
      expect(userFacingMessage(failure)).toBeUndefined();
    } finally { await ts.close(); }
  });

  it("unwraps typed MCP failures while leaving unrecognized provider errors generic", () => {
    const error = new McpToolError("Example MCP timed out after 12345ms");
    expect(userFacingMessage(new RetryError({ message: "retry", reason: "errorNotRetryable", errors: [error] }))).toBe(error.message);
    expect(userFacingMessage(new Error("upstream body with credentials"))).toBeUndefined();
    expect(userFacingMessage(new APICallError({ message: "raw provider body", url: "https://example.com", requestBodyValues: {} }))).toBeUndefined();
  });

  it("keeps the timeout in live model feedback, saved tool output, and replayed model history", async () => {
    const c = client(new Error(`Request timed out after 12345ms ${apiKey}`));
    const ts = toolset();
    const name = ts.entries[0].name;
    const tools = { [name]: ts.entries[0].tool };
    const model = new MockLanguageModelV4({ doStream: [
      { stream: convertArrayToReadableStream([
        { type: "tool-call", toolCallId: "call-1", toolName: name, input: "{}" }, finishPart("tool-calls"),
      ]) },
      { stream: convertArrayToReadableStream([...text("answer", "The report timed out."), finishPart("stop")]) },
    ] });
    try {
      const result = streamText({ model, messages: [{ role: "user", content: "Run the report." }], tools, stopWhen: isStepCount(2) });
      const stream = toUIMessageStream({ stream: result.stream, tools, onError: (e) => userFacingMessage(e) ?? "An error occurred." });
      const reader = stream.getReader();
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const expected = 'get_status on "Example MCP" failed: Request timed out after 12345ms [redacted]';
      expect(chunks).toContainEqual(expect.objectContaining({ type: "tool-output-error", toolCallId: "call-1", errorText: expected }));
      const saved = await reduce(chunks);
      expect(saved.parts).toContainEqual(expect.objectContaining({ state: "output-error", errorText: expected }));
      const replay = await convertToModelMessages([saved], { tools });
      expect(JSON.stringify(replay)).toContain(expected.replaceAll('"', '\\"'));
      expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain("Request timed out after 12345ms [redacted]");
      expect(JSON.stringify({ chunks, saved, replay, calls: model.doStreamCalls })).not.toContain(apiKey);
      expect(c.callTool).toHaveBeenCalledTimes(1);
      expect(c.callTool).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ timeout: 12_345 }) }));
    } finally { await ts.close(); }
  });
});
