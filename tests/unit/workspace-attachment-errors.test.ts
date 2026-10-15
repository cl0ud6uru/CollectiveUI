import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const f = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/files/storage", () => ({ storage: () => ({ get: f.get }) }));
vi.mock("@/db", async () => {
  const { attachments } = await import("@/db/schema");
  return { db: { select: () => ({ from: (table: unknown) => {
    const rows = table === attachments ? [{ id: "fixture", userId: "owner", size: 1, storageKey: "fixture", filename: "fixture.txt" }] : [{ id: "message" }];
    const chain = { innerJoin: () => chain, where: () => Object.assign(Promise.resolve(rows), { limit: async () => rows }) };
    return chain;
  } }) } };
});
import { workspaceAttachmentTool } from "@/lib/agent/tools/workspace-attachment";
import { SandboxError } from "@/lib/sandbox/client";
afterEach(() => vi.restoreAllMocks());
describe("workspace attachment failure boundary", () => {
  it.each([new Error("arbitrary-import-secret https://internal.fixture.invalid"), new SandboxError("internal", "arbitrary-import-secret https://internal.fixture.invalid")])("returns safe diagnostics and result text for import failure", async error => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    f.get.mockRejectedValue(error);
    const entry = workspaceAttachmentTool({ principal: { user: { id: "owner" } }, conversationId: "conversation" } as never, {} as never);
    const result = await entry.tool.execute!({ attachmentId: "fixture" }, { toolCallId: "import", messages: [], context: {} });
    expect(result).toMatchObject({ ok: false, reason: "import_failed", message: expect.stringMatching(/^Something went wrong\. Try again\. Reference:/) });
    expect(inspect([result, log.mock.calls])).not.toMatch(/arbitrary-import-secret|internal\.fixture\.invalid/);
  });
});
