import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Principal } from "@/lib/auth/groups";

const enabled = process.env.ATTACHMENT_POSTGRES_PROOF === "1";
const fixtureURL = process.env.ATTACHMENT_POSTGRES_URL;
if (enabled) {
  const url = new URL(fixtureURL ?? "invalid:");
  if (url.protocol !== "postgres:" || url.hostname !== "127.0.0.1" || url.port !== "55445" ||
      url.pathname !== "/collective_attachments_test" || url.search || url.hash ||
      Object.keys(process.env).some(key => key.startsWith("PG") && process.env[key])) {
    throw new Error("Requires the explicit dedicated loopback attachment fixture with no PG overrides");
  }
}
const session = vi.hoisted(() => ({ principal: null as Principal | null }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("Not found"); } }));
vi.mock("@/lib/session", () => ({ requirePrincipal: async () => session.principal!, requirePagePrincipal: async () => session.principal! }));
// Render the real server page into its props without loading the browser's client-side UI graph.
vi.mock("@/components/chat/shared-view", () => ({ SharedView: () => null }));

let q: typeof import("@/db");
let actions: typeof import("@/app/(chat)/actions");
let SharedPage: typeof import("@/app/share/[token]/page").default;
let notice: string;

describe.skipIf(!enabled)("private files in shared snapshots on disposable PostgreSQL", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = fixtureURL!;
    q = await import("@/db");
    actions = await import("@/app/(chat)/actions");
    SharedPage = (await import("@/app/share/[token]/page")).default;
    notice = (await import("@/lib/chat/shared-attachments")).SHARED_ATTACHMENT_NOTICE;
    await q.db.insert(q.schema.users).values([
      { id: "share-owner", name: "Owner", upn: "owner@fixture.invalid", authSource: "ldap" },
      { id: "share-viewer", name: "Viewer", upn: "viewer@fixture.invalid", authSource: "ldap" },
    ]);
    session.principal = (await (await import("@/lib/auth/groups")).loadPrincipal("share-viewer"))!;
  });
  beforeEach(async () => {
    await q.db.delete(q.schema.conversations);
    await q.db.insert(q.schema.conversations).values({ id: "share-chat", userId: "share-owner", title: "Files stay private" });
    await q.db.insert(q.schema.messages).values([
      { id: "share-first", conversationId: "share-chat", role: "user", parts: [{ type: "text", text: "Before cutoff" }, { type: "file", url: "/api/files/privateFile", filename: "secret-name.txt", mediaType: "text/plain" }], searchText: "Before cutoff secret-name.txt" },
      { id: "share-later", parentId: "share-first", conversationId: "share-chat", role: "assistant", parts: [{ type: "text", text: "After cutoff" }], searchText: "After cutoff" },
    ]);
    await q.db.insert(q.schema.sharedLinks).values({ id: "share-token", conversationId: "share-chat", cutoffMessageId: "share-first", createdBy: "share-owner" });
  });
  afterAll(async () => { await q?.pool.end(); });
  const page = () => SharedPage({ params: Promise.resolve({ token: "share-token" }) } as never);

  it("omits file URLs and filenames, explains omission and preserves the cutoff", async () => {
    const view = await page();
    expect(view.props.attachmentsOmitted).toBe(true);
    expect(view.props.messages).toHaveLength(1);
    expect(JSON.stringify(view.props.messages)).not.toMatch(/privateFile|secret-name|After cutoff/);
    expect(view.props.messages[0].parts).toContainEqual({ type: "text", text: notice });
  });
  it("copies only the cutoff path and replaces private files with the same explanation and searchable text", async () => {
    const id = await actions.continueSharedConversation("share-token");
    const copies = await q.db.select().from(q.schema.messages).where(eq(q.schema.messages.conversationId, id));
    expect(copies).toHaveLength(1);
    expect(copies[0].parts).toContainEqual({ type: "text", text: notice });
    expect(copies[0].searchText).toContain(notice);
    expect(JSON.stringify(copies)).not.toMatch(/privateFile|secret-name|After cutoff/);
  });
  it("rejects revoked shared views and copies", async () => {
    await q.db.update(q.schema.sharedLinks).set({ revokedAt: new Date() });
    await expect(page()).rejects.toThrow("Not found");
    await expect(actions.continueSharedConversation("share-token")).rejects.toThrow("Link not found");
  });
  it("rechecks a revocation committed after the initial lookup, before copying any rows", async () => {
    const original = q.db.transaction.bind(q.db);
    const spy = vi.spyOn(q.db, "transaction").mockImplementationOnce(async (callback, config) => {
      await q.db.update(q.schema.sharedLinks).set({ revokedAt: new Date() });
      return original(callback, config);
    });
    try {
      await expect(actions.continueSharedConversation("share-token")).rejects.toThrow("Link not found");
      expect(await q.db.select().from(q.schema.conversations)).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });
});
