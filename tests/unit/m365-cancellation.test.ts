import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCtx } from "@/lib/agent/types";
import { m365Tools } from "@/lib/agent/tools/m365";

const h = vi.hoisted(() => ({ graph: vi.fn() }));
vi.mock("@/lib/auth/entra", () => ({ graphFetch: h.graph }));

const ctx = { principal: { user: { id: "fixture-owner" } } } as AgentCtx;
const inputs = {
  m365_search_mail: { query: "fixture" },
  m365_calendar: { start: "2026-10-01", end: "2026-10-02" },
  m365_search_files: { query: "fixture" },
  m365_send_mail: { to: ["recipient@example.invalid"], subject: "Fixture", body: "Synthetic message" },
};
function invoke(name: keyof typeof inputs, abortSignal?: AbortSignal) {
  const entry = m365Tools(ctx).find(t => t.name === name)!;
  return entry.tool.execute!(inputs[name], { toolCallId: "fixture-call", messages: [], context: undefined, abortSignal });
}

describe("Microsoft 365 tool cancellation", () => {
  beforeEach(() => { h.graph.mockReset(); h.graph.mockResolvedValue({ value: [] }); });

  it.each(Object.keys(inputs) as (keyof typeof inputs)[])("does not dispatch an already canceled %s", async name => {
    const reason = new Error("fixture stopped before dispatch");
    await expect(invoke(name, AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(h.graph).not.toHaveBeenCalled();
  });

  it.each(Object.keys(inputs) as (keyof typeof inputs)[])("passes the run signal to %s", async name => {
    const controller = new AbortController();
    await invoke(name, controller.signal);
    expect(h.graph.mock.calls[0][2]).toEqual(expect.objectContaining({ signal: controller.signal }));
  });

  it("aborts a blocked send without reporting success or retrying", async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const dispatched = new Promise<void>(resolve => { entered = resolve; });
    h.graph.mockImplementation((_owner, _path, init) => new Promise((_resolve, reject) => {
      entered();
      init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    const result = invoke("m365_send_mail", controller.signal);
    await dispatched;
    // An abort reason containing JSON must never be mistaken for an empty successful response.
    const reason = new Error("fixture JSON send canceled; delivery may have occurred");
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    expect(h.graph).toHaveBeenCalledTimes(1);
  });

  it("preserves an acknowledged send even if Stop arrives after the remote effect", async () => {
    const controller = new AbortController();
    h.graph.mockImplementation(async () => { controller.abort(); });
    await expect(invoke("m365_send_mail", controller.signal)).resolves.toEqual({ sent: true, to: inputs.m365_send_mail.to });
    expect(h.graph).toHaveBeenCalledTimes(1);
  });

  it("does not swallow an unrelated JSON failure as a sent message", async () => {
    const failure = new Error("fixture invalid JSON response");
    h.graph.mockRejectedValue(failure);
    await expect(invoke("m365_send_mail")).rejects.toBe(failure);
  });
});
