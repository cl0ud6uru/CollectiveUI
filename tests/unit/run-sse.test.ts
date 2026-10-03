import { JsonToSseTransformStream, UI_MESSAGE_STREAM_HEADERS, type UIMessageChunk } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sseResponse } from "@/lib/runs/sse";

const chunks: UIMessageChunk[] = [
  { type: "start", messageId: "m1" },
  { type: "text-start", id: "0" },
  { type: "text-delta", id: "0", delta: 'say "hi"\n' },
  { type: "text-end", id: "0" },
  { type: "finish" },
];

async function readAll(body: ReadableStream<Uint8Array> | ReadableStream<string>) {
  let out = "";
  const decoder = new TextDecoder();
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += typeof value === "string" ? value : decoder.decode(value, { stream: true });
  }
}

/** A source the test drives by hand. */
function manualSource() {
  let controller!: ReadableStreamDefaultController<UIMessageChunk>;
  const cancel = vi.fn();
  const stream = new ReadableStream<UIMessageChunk>({
    start(c) {
      controller = c;
    },
    cancel,
  });
  return { stream, cancel, push: (c: UIMessageChunk) => controller.enqueue(c), end: () => controller.close() };
}

afterEach(() => {
  vi.useRealTimers();
  delete process.env.RUN_KEEPALIVE_MS;
});

describe("sseResponse", () => {
  it("frames chunks exactly like the SDK's JsonToSseTransformStream, with the UI stream headers", async () => {
    const source = () =>
      new ReadableStream<UIMessageChunk>({
        start(c) {
          for (const x of chunks) c.enqueue(x);
          c.close();
        },
      });
    const res = sseResponse(source());
    const expected = await readAll(source().pipeThrough(new JsonToSseTransformStream()));
    expect(await readAll(res.body!)).toBe(expected);
    expect(expected.endsWith("data: [DONE]\n\n")).toBe(true);
    for (const [k, v] of Object.entries(UI_MESSAGE_STREAM_HEADERS)) expect(res.headers.get(k)).toBe(v);
    expect(res.status).toBe(200);
  });

  it("keeps the caller's status and headers", () => {
    const res = sseResponse(manualSource().stream, { status: 201, headers: { "cache-control": "no-store", "x-run-id": "r1" } });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-run-id")).toBe("r1");
    expect(res.headers.get("content-type")).toBe("text/event-stream");
  });

  it("sends a keepalive comment while the source is quiet, and stops at the end", async () => {
    vi.useFakeTimers();
    process.env.RUN_KEEPALIVE_MS = "1000";
    const src = manualSource();
    const reader = sseResponse(src.stream).body!.getReader();
    const decoder = new TextDecoder();
    const next = async () => decoder.decode((await reader.read()).value);

    src.push(chunks[0]);
    expect(await next()).toBe(`data: ${JSON.stringify(chunks[0])}\n\n`);
    const pending = next();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBe(": keepalive\n\n");
    src.end();
    expect(await next()).toBe("data: [DONE]\n\n");
    expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancelling the response cancels the source and clears the keepalive", async () => {
    vi.useFakeTimers();
    const src = manualSource();
    const reader = sseResponse(src.stream).body!.getReader();
    src.push(chunks[0]);
    await reader.read();
    expect(vi.getTimerCount()).toBe(1);
    await reader.cancel("client went away");
    expect(src.cancel).toHaveBeenCalledWith("client went away");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a failing source errors the response", async () => {
    const src = new ReadableStream<UIMessageChunk>({
      pull() {
        throw new Error("database down");
      },
    });
    await expect(readAll(sseResponse(src).body!)).rejects.toThrow("database down");
  });
});
