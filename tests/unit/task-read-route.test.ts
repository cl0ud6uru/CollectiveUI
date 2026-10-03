import { afterEach, describe, expect, it, vi } from "vitest";

const read = vi.hoisted(() => vi.fn());
vi.mock("@/lib/delegation/read", () => ({ markTaskRead: read }));
vi.mock("@/lib/session", () => ({ requirePrincipal: async () => ({ user: { id: "owner" } }), errorResponse: () => new Response(null, { status: 500 }) }));
import { POST } from "@/app/api/chat/[id]/read/route";

afterEach(() => { vi.unstubAllEnvs(); read.mockReset(); });
describe("task read route", () => {
  const request = (origin: string, status = "succeeded") => new Request("http://0.0.0.0:3000/api/chat/child/read", {
    method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify({ runId: "run", status, lastSeq: 12 }),
  });
  it("accepts the configured external origin behind a reverse proxy", async () => {
    vi.stubEnv("AUTH_URL", "https://chat.example.test");
    expect((await POST(request("https://chat.example.test"), { params: Promise.resolve({ id: "child" }) })).status).toBe(204);
    expect(read).toHaveBeenCalledWith({ user: { id: "owner" } }, "child", { runId: "run", status: "succeeded", lastSeq: 12 });
  });
  it("rejects another origin and nonterminal snapshots without changing read state", async () => {
    vi.stubEnv("AUTH_URL", "https://chat.example.test");
    expect((await POST(request("https://other.example.test"), { params: Promise.resolve({ id: "child" }) })).status).toBe(403);
    expect((await POST(request("https://chat.example.test", "running"), { params: Promise.resolve({ id: "child" }) })).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });
});
