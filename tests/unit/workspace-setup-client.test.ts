import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NonceCache, verifyRequest } from "@/sandboxd/protocol/auth";
vi.mock("server-only", () => ({}));
import { readWorkspaceSetup } from "@/lib/sandbox/setup-server";

afterEach(() => vi.unstubAllEnvs());
describe("workspace check against isolated signed HTTP fixture", () => {
  it("uses health only, signs it, sanitizes daemon failures, and retries", async () => {
    const secret = "CANARY_SECRET".repeat(4); let mode = "failure"; const requests: string[] = []; const nonces = new NonceCache();
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      const verified = verifyRequest(secret, { method: req.method!, path: req.url!, body: Buffer.alloc(0), headers: req.headers, now: Date.now(), nonces });
      if (!verified.ok) { res.writeHead(401); res.end(JSON.stringify({ error: "unauthorized", message: secret })); return; }
      if (mode === "failure") { res.writeHead(500); res.end(JSON.stringify({ error: "internal", message: secret })); return; }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, docker: { version: secret, apiVersion: secret }, image: { present: true, ref: secret },
        gvisor: { available: true, reason: secret }, defaultRuntime: "runsc", warnings: [secret] }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    try {
      vi.stubEnv("SANDBOXD_URL", `http://127.0.0.1:${address.port}`); vi.stubEnv("SANDBOXD_SECRET", secret);
      const failed = await readWorkspaceSetup(false); expect(failed.ready).toBe(false); expect(JSON.stringify(failed)).not.toContain(secret);
      mode = "success"; const passed = await readWorkspaceSetup(false); expect(passed.ready).toBe(true); expect(JSON.stringify(passed)).not.toContain(secret);
      vi.stubEnv("SANDBOXD_SECRET", "wrong_shared_secret".repeat(3));
      const unauthenticated = await readWorkspaceSetup(false); expect(unauthenticated.ready).toBe(false); expect(unauthenticated.checks[1].detail).toContain("Authentication failed");
      expect(requests).toEqual(["GET /v1/health", "GET /v1/health", "GET /v1/health"]);
      vi.stubEnv("SANDBOXD_URL", ""); expect((await readWorkspaceSetup(false)).ready).toBe(false); expect(requests).toHaveLength(3);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
