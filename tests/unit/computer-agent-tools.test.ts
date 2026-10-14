import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/local-hermes/client", () => ({
  LOCAL_ORIGIN: "http://127.0.0.1",
  socketFetch: () => transport,
}));

import { COMPUTER_DYNAMIC_TOOLS, invokeComputerTool, managedComputerAgent, type ComputerAgent } from "@/lib/computer/agent";

const runtime = { ownerId: "owner-1", socketPath: "/tmp/personal-codex.sock", managed: true } as never;
const agent: ComputerAgent = { runtime: { ownerId: "owner-1", socketPath: "/tmp/personal-codex.sock" }, tools: COMPUTER_DYNAMIC_TOOLS };
const controller = new AbortController();
const authorize = vi.fn(async () => {});

function validJpeg() {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x03, 0x20, 0x05, 0x00, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9]);
}

describe("managed Codex computer tools", () => {
  beforeEach(() => {
    transport.mockReset(); authorize.mockClear();
    vi.stubEnv("COMPUTER_VIEW_ENABLED", "1");
    vi.stubEnv("AUTH_WEB_SESSION_REGISTRY_ENABLED", "1");
  });

  it("registers only the five bounded tools with strict schemas", () => {
    expect(COMPUTER_DYNAMIC_TOOLS.map(t => t.name)).toEqual([
      "computer_screenshot", "computer_click", "computer_type", "computer_key", "computer_scroll",
    ]);
    for (const tool of COMPUTER_DYNAMIC_TOOLS) expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(COMPUTER_DYNAMIC_TOOLS.find(t => t.name === "computer_type")?.inputSchema).toMatchObject({
      properties: { text: { type: "string", maxLength: 4000 } },
    });
  });

  it("offers tools only for enabled managed runtimes with a running, unpaused broker", async () => {
    const status = { available: true, state: "running", control: "agent", paused: false, lastFrameAt: null, width: 1280, height: 800 };
    transport.mockResolvedValueOnce(Response.json(status));
    await expect(managedComputerAgent(runtime)).resolves.toMatchObject({ runtime: agent.runtime });
    expect(transport).toHaveBeenCalledWith("http://127.0.0.1/computer/agent/status", expect.objectContaining({
      headers: { "x-collective-owner": "owner-1", "x-collective-view-session": "0".repeat(64) },
    }));

    transport.mockResolvedValueOnce(Response.json({ ...status, paused: true }));
    await expect(managedComputerAgent(runtime)).resolves.toBeNull();
    vi.stubEnv("AUTH_WEB_SESSION_REGISTRY_ENABLED", "0");
    await expect(managedComputerAgent(runtime)).resolves.toBeNull();
  });

  it("rejects spoofed kinds and extra fields before broker input", async () => {
    const invalid = [
      ["computer_click", { kind: "type", text: "secret" }],
      ["computer_click", { x: 1, y: 2, extra: true }],
      ["computer_type", { text: "hello", kind: "click" }],
      ["computer_key", { key: "Enter", text: "secret" }],
      ["computer_scroll", { direction: "up", amount: 1, kind: "click" }],
    ] as const;
    for (const [tool, args] of invalid) {
      const result = await invokeComputerTool(agent, tool, args, controller.signal, authorize);
      expect(result.success).toBe(false);
    }
    expect(transport).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("keeps screenshot bytes bounded and reauthorizes after capture before releasing the image", async () => {
    transport.mockResolvedValueOnce(new Response(validJpeg(), { headers: { "content-type": "image/jpeg" } }));
    const result = await invokeComputerTool(agent, "computer_screenshot", {}, controller.signal, authorize);
    expect(result.success).toBe(true);
    expect(result.contentItems[0]?.type).toBe("inputImage");
    expect(authorize).toHaveBeenCalledTimes(2);

    transport.mockReset(); authorize.mockReset().mockResolvedValue(undefined);
    transport.mockResolvedValueOnce(new Response(new Uint8Array(512 * 1024 + 1), { headers: { "content-type": "image/jpeg" } }));
    const tooLarge = await invokeComputerTool(agent, "computer_screenshot", {}, controller.signal, authorize);
    expect(tooLarge.success).toBe(false);
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it("sends only schema-validated input through the broker lease fence", async () => {
    transport.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const result = await invokeComputerTool(agent, "computer_type", { text: "hello" }, controller.signal, authorize);
    expect(result.success).toBe(true);
    expect(transport).toHaveBeenCalledWith("http://127.0.0.1/computer/agent/input", expect.objectContaining({
      method: "POST", body: JSON.stringify({ kind: "type", text: "hello" }),
    }));
    expect(authorize).toHaveBeenCalledTimes(1);

    transport.mockResolvedValueOnce(new Response(null, { status: 409 }));
    const paused = await invokeComputerTool(agent, "computer_click", { x: 3, y: 4 }, controller.signal, authorize);
    expect(paused.success).toBe(false);
  });
});
