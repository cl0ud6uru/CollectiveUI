import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ read: vi.fn(), principal: vi.fn(async () => ({ user: { id: "owner" } })) }));
vi.mock("@/lib/session", () => ({ requirePrincipal: f.principal, errorResponse: (e: { status?: number; message: string }) => Response.json({ error: e.message }, { status: e.status ?? 500 }) }));
vi.mock("@/lib/delegation/activity", () => ({ taskActivity: f.read }));
import { GET } from "@/app/api/delegation/[taskId]/activity/route";
const ctx = { params: Promise.resolve({ taskId: "exact-task" }) };
beforeEach(() => vi.clearAllMocks());
it("serves uncached activity for the signed-in owner and the exact requested assignment", async () => {
  f.read.mockResolvedValue({ taskId: "exact-task", status: "working", steps: [], completed: 0 });
  const response = await GET(new Request("https://portal.test"), ctx);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(f.read).toHaveBeenCalledWith({ user: { id: "owner" } }, "exact-task");
});
it.each([401, 403, 404])("does not return activity when access fails with %s", async status => {
  f.read.mockRejectedValue({ status, message: "Unavailable" });
  const response = await GET(new Request("https://portal.test"), ctx);
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: "Unavailable" });
});
