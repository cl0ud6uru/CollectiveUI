import { describe, expect, it, vi } from "vitest";
import { chatSendFetch } from "@/lib/chat/send-fetch";

describe("send response refresh", () => {
  it.each([200, 400, 409, 503])("re-reads committed navigation at response %s without consuming the response stream", async status => {
    const refresh = vi.fn();
    const response = new Response("body", { status });
    const request = vi.fn<typeof fetch>().mockResolvedValue(response);
    const result = await chatSendFetch(refresh, request)("/api/chat", { method: "POST", body: JSON.stringify({ message: { role: "user" } }) });
    expect(refresh).toHaveBeenCalledOnce(); expect(result).toBe(response); expect(result.bodyUsed).toBe(false);
  });
  it("does not refresh opening, stream reconnect, approvals, regeneration or failed network attempts", async () => {
    const refresh = vi.fn(); const request = vi.fn<typeof fetch>().mockResolvedValue(new Response());
    const send = chatSendFetch(refresh, request);
    await send("/api/chat/id/stream", { method: "GET" });
    for (const body of [{ message: { role: "assistant" } }, { regenerate: true, message: { role: "user" } }])
      await send("/api/chat", { method: "POST", body: JSON.stringify(body) });
    request.mockRejectedValueOnce(new TypeError("Network unavailable"));
    await expect(send("/api/chat", { method: "POST", body: JSON.stringify({ message: { role: "user" } }) })).rejects.toThrow("Network unavailable");
    expect(refresh).not.toHaveBeenCalled();
  });
});
