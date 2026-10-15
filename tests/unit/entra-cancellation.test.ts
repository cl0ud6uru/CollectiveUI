import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { graphFetch } from "@/lib/auth/entra";
import { createServer } from "node:http";

const nativeFetch = globalThis.fetch;

const h = vi.hoisted(() => ({
  lookup: vi.fn(), select: vi.fn(), fetch: vi.fn(),
}));
vi.mock("@/db", () => ({ db: {
  select: h.select,
  insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }),
} }));
vi.mock("@/lib/crypto", () => ({
  AAD: { userAccessToken: "access", userRefreshToken: "refresh" },
  decrypt: (value: string) => value, decryptOptional: (value: string) => value,
  encrypt: (value: string) => value, encryptOptional: (value: string) => value,
}));
const row = () => ({ accessTokenEnc: "fixture-access", refreshTokenEnc: "fixture-refresh", expiresAt: new Date(Date.now() + 3_600_000), scope: "User.Read" });

describe("Graph request cancellation", () => {
  beforeEach(() => {
    h.select.mockReset(); h.lookup.mockReset(); h.fetch.mockReset();
    h.select.mockImplementation(() => ({ from: () => ({ where: h.lookup }) }));
    h.lookup.mockResolvedValue([row()]);
    vi.stubGlobal("fetch", h.fetch);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("does not look up a token or dispatch when already canceled", async () => {
    const reason = new Error("fixture canceled");
    await expect(graphFetch("fixture-owner", "/me/sendMail", { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(h.select).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
  });

  it("rechecks cancellation after token lookup before sending mail", async () => {
    const controller = new AbortController(), reason = new Error("fixture stopped during token lookup");
    h.lookup.mockImplementation(async () => { controller.abort(reason); return [row()]; });
    await expect(graphFetch("fixture-owner", "/me/sendMail", { signal: controller.signal })).rejects.toBe(reason);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("propagates cancellation through an in-flight token refresh", async () => {
    vi.stubEnv("AUTH_MICROSOFT_ENTRA_ID_ISSUER", "https://login.example.invalid/fixture/v2.0");
    h.lookup.mockResolvedValue([{ ...row(), expiresAt: new Date(0) }]);
    const controller = new AbortController(), reason = new Error("fixture refresh stopped");
    let entered!: () => void;
    const dispatched = new Promise<void>(resolve => { entered = resolve; });
    h.fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      entered();
      init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    const result = graphFetch("fixture-owner", "/me/sendMail", { signal: controller.signal });
    await dispatched; controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls[0][0]).toBe("https://login.example.invalid/fixture/oauth2/v2.0/token");
    expect(h.fetch.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("aborts a blocked Graph request after dispatch", async () => {
    const controller = new AbortController(), reason = new Error("fixture graph stopped");
    let entered!: () => void;
    const dispatched = new Promise<void>(resolve => { entered = resolve; });
    h.fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      entered(); init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    const result = graphFetch("fixture-owner", "/me/sendMail", { method: "POST", signal: controller.signal });
    await dispatched; controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([202, 204])("accepts an explicitly empty successful Graph response (%s)", async status => {
    h.fetch.mockResolvedValue(new Response(null, { status }));
    await expect(graphFetch("fixture-owner", "/me/sendMail", { method: "POST" })).resolves.toBeUndefined();
  });

  it("keeps normal JSON parsing failures visible", async () => {
    h.fetch.mockResolvedValue(new Response("invalid fixture JSON", { status: 200 }));
    await expect(graphFetch("fixture-owner", "/me/messages")).rejects.toThrow();
  });

  it("preserves JSON returned with an accepted response", async () => {
    h.fetch.mockResolvedValue(Response.json({ operation: "fixture-operation" }, { status: 202 }));
    await expect(graphFetch("fixture-owner", "/fixture-operation", { method: "POST" })).resolves.toEqual({ operation: "fixture-operation" });
  });

  it("preserves a real HTTP mail acknowledgement when Stop aborts its unfinished body", async () => {
    // Flush only headers: native fetch acknowledges the response while the body remains pending.
    const server = createServer((_request, response) => {
      response.writeHead(202, { "Content-Type": "application/json" });
      response.flushHeaders();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture listener");
    const controller = new AbortController(), reason = new Error("fixture stopped after acknowledgement");
    let acknowledged!: () => void, release!: () => void;
    const headersReceived = new Promise<void>(resolve => { acknowledged = resolve; });
    const releaseResponse = new Promise<void>(resolve => { release = resolve; });
    h.fetch.mockImplementation(async (_url, init) => {
      const response = await nativeFetch(`http://127.0.0.1:${address.port}/sendMail`, init);
      acknowledged();
      await releaseResponse;
      return response;
    });
    try {
      const result = graphFetch("fixture-owner", "/me/sendMail", { method: "POST", signal: controller.signal });
      await headersReceived;
      controller.abort(reason);
      release();
      await expect(result).resolves.toBeUndefined();
      expect(h.fetch).toHaveBeenCalledTimes(1);
    } finally {
      release(); controller.abort(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
