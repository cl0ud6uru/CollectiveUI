import { createHash } from "node:crypto";
import { streamText } from "ai";
import { describe, expect, it } from "vitest";
import { startRun, type HermesTarget } from "@/lib/llm/providers/hermes/client";
import { HermesLanguageModel } from "@/lib/llm/providers/hermes/model";

// Synthetic profile, credentials, names, and file contents only.
const file = { name: "example.doc", mediaType: "application/msword", contentBase64: Buffer.from("synthetic document bytes").toString("base64") };
const request = { input: "Review the file.", attachments: [file], sessionId: "example-conversation", sessionKey: "example-scope", idempotencyKey: "example-run" };
const receipt = { id: "a".repeat(32), name: file.name, media_type: file.mediaType,
  sha256: createHash("sha256").update(Buffer.from(file.contentBase64, "base64")).digest("hex"), size: Buffer.from(file.contentBase64, "base64").length };

function transport(options: { supported?: boolean; uploadStatus?: number; corrupt?: boolean; events?: boolean } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const target: HermesTarget = { baseUrl: "https://hermes.example.test", profile: "example", apiKey: "synthetic-api-key",
    fetch: (async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/v1/capabilities")) return Response.json({ features: options.supported === false ? {} : { run_attachments: { version: 1 } } });
      if (url.endsWith("/v1/attachments")) return Response.json(options.corrupt ? { ...receipt, sha256: "wrong" } : receipt, { status: options.uploadStatus ?? 201 });
      if (url.endsWith("/v1/runs")) return Response.json({ run_id: "run_example" }, { status: 202 });
      if (url.endsWith("/events") && options.events) return new Response('data: {"event":"run.completed","output":"Done","usage":{}}\n\n', { headers: { "Content-Type": "text/event-stream" } });
      throw new Error("Unexpected synthetic request");
    }) as typeof fetch };
  return { calls, target };
}

describe("remote Hermes original-file delivery", () => {
  it("uploads exact bytes on the selected profile, validates the receipt, then starts a run containing only file IDs", async () => {
    const { calls, target } = transport();
    expect(await startRun(target, request)).toBe("run_example");
    expect(calls.map(c => new URL(c.url).pathname)).toEqual([
      "/p/example/v1/capabilities", "/p/example/v1/attachments", "/p/example/v1/runs",
    ]);
    expect(Buffer.from(calls[1].init.body as Uint8Array)).toEqual(Buffer.from(file.contentBase64, "base64"));
    expect(calls[1].init.headers).toMatchObject({ "Content-Type": "application/msword", "X-Hermes-Session-Id": request.sessionId,
      "X-Hermes-Session-Key": request.sessionKey, "Idempotency-Key": "example-run:file:0", Authorization: "Bearer synthetic-api-key" });
    expect(calls.every(c => c.init.redirect === "error")).toBe(true);
    expect(JSON.parse(String(calls[2].init.body))).toEqual({ input: request.input, session_id: request.sessionId, file_ids: [receipt.id] });
    expect(String(calls[2].init.body)).not.toContain(file.contentBase64);
    expect(String(calls[2].init.body)).not.toContain(target.apiKey);
  });

  it("supports files-only messages", async () => {
    const { calls, target } = transport();
    await startRun(target, { ...request, input: "" });
    expect(JSON.parse(String(calls.at(-1)!.init.body)).input).toBe("Review the uploaded files.");
  });

  it.each([{ supported: false }, { uploadStatus: 413 }, { corrupt: true }])("does not start inference when delivery is unsupported, rejected, or corrupt: %j", async options => {
    const { calls, target } = transport(options);
    await expect(startRun(target, request)).rejects.toThrow();
    expect(calls.some(c => c.url.endsWith("/v1/runs"))).toBe(false);
    if (options.supported === false) expect(calls.some(c => c.url.endsWith("/v1/attachments"))).toBe(false);
  });

  it("requires a conversation and memory scope before contacting the remote server", async () => {
    const { calls, target } = transport();
    await expect(startRun(target, { ...request, sessionKey: null })).rejects.toThrow(/conversation/);
    expect(calls).toHaveLength(0);
  });

  it("uses stable upload identities when a run is retried", async () => {
    const { calls, target } = transport();
    await startRun(target, request);
    await startRun(target, request);
    expect(calls.filter(c => c.url.endsWith("/v1/attachments")).map(c => (c.init.headers as Record<string, string>)["Idempotency-Key"]))
      .toEqual(["example-run:file:0", "example-run:file:0"]);
  });

  it("stages a batch sequentially and refuses to admit a run after a later upload fails", async () => {
    let active = 0, maxActive = 0, uploads = 0, runs = 0;
    const { target } = transport();
    target.fetch = (async (input) => {
      if (String(input).endsWith("/v1/capabilities")) return Response.json({ features: { run_attachments: { version: 1 } } });
      if (String(input).endsWith("/v1/runs")) { runs++; return Response.json({ run_id: "unexpected" }); }
      uploads++; active++; maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 1)); active--;
      return Response.json(receipt, { status: uploads === 1 ? 201 : 413 });
    }) as typeof fetch;
    await expect(startRun(target, { ...request, attachments: [file, file] })).rejects.toThrow();
    expect({ uploads, runs, maxActive }).toEqual({ uploads: 2, runs: 0, maxActive: 1 });
  });

  it("the provider forwards resolved original bytes instead of stripping remote file parts", async () => {
    const { calls, target } = transport({ events: true });
    const model = new HermesLanguageModel("example-model", { target, sessionId: request.sessionId, sessionKey: request.sessionKey,
      interactive: true, approvalTimeoutSec: 300 });
    const result = streamText({ model, messages: [{ role: "user", content: [
      { type: "text", text: request.input },
      { type: "file", filename: file.name, mediaType: file.mediaType, data: Buffer.from(file.contentBase64, "base64") },
    ] }] });
    expect(await result.text).toBe("Done");
    expect(calls.some(c => c.url.endsWith("/v1/attachments"))).toBe(true);
    expect(String(calls.find(c => c.url.endsWith("/v1/runs"))!.init.body)).not.toContain("not passed on");
  });
});
