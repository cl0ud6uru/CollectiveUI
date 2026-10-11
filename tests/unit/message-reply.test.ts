import { describe, expect, it, vi } from "vitest";
import type { Message, AiApp } from "@/db/schema";
import type { PortalUIMessage } from "@/lib/chat/store";
vi.mock("@/db", () => ({ db: { select: () => { throw new Error("No database access in reply fixture"); } } }));
vi.mock("@/lib/authz", () => import("@/lib/http-error"));
vi.mock("@/lib/files/storage", () => ({ storage: () => { throw new Error("No files in reply fixture"); } }));
import { replyAddress, replyContext } from "@/lib/chat/reply";
import { resolveReplyReference, resolveStoredReplyReference } from "@/lib/chat/reply-server";
import * as store from "@/lib/chat/store";
import { resolveMentions } from "@/lib/agent/mentions";
import { resolveAttachmentsForModel } from "@/lib/agent/prepare";

const group: PortalUIMessage = { id: "assistant-source", role: "assistant", parts: [
  { type: "data-speaker", data: { botId: "researcher", name: "Researcher" } },
  { type: "text", text: "Research findings @Writer" },
  { type: "reasoning", text: "Private reasoning" },
  { type: "dynamic-tool", toolName: "fixture", toolCallId: "tool", state: "output-available", input: { secret: "hidden" }, output: "Tool secret" },
  { type: "data-speaker", data: { botId: "writer", name: "Writer" } },
  { type: "text", text: "First draft" },
  { type: "data-speaker", data: { botId: "researcher", name: "Researcher" } },
  { type: "text", text: "Revised findings" },
] };
function row(message: PortalUIMessage, parentId: string | null, conversationId = "own-chat"): Message {
  return { id: message.id, parentId, conversationId, role: message.role, parts: message.parts, metadata: message.metadata ?? null, createdAt: new Date(0) } as Message;
}
const user: PortalUIMessage = { id: "root", role: "user", parts: [{ type: "text", text: "Original question" }] };
const rows = [row(user, null), row(group, user.id)];
describe("message replies", () => {
  it("reloads a stopped parent that persisted after the initial conversation snapshot", async () => {
    const load = vi.spyOn(store, "loadMessageRows").mockResolvedValueOnce(rows);
    const result = await resolveStoredReplyReference("own-chat", group.id, { messageId: group.id, speakerIndex: 0 }, "Group");
    expect(result.excerpt).toBe("Research findings @Writer");expect(load).toHaveBeenCalledWith("own-chat");load.mockRestore();
  });
  it("rejects ambiguous/reserved bot names and separates overlapping names from an existing draft", () => {
    expect(replyAddress("two", [{id:"one",name:"Planner"},{id:"two",name:"Planner"}])).toBeNull();
    for (const name of ["Everyone", "All", "Channel"]) expect(replyAddress("one", [{id:"one",name},{id:"two",name:"Writer"}])).toBeNull();
    const members=[{id:"one",name:"Research"},{id:"two",name:"Research Assistant"}];
    expect(resolveMentions(replyAddress("one", members)! + "Assistant, clarify this", members)).toEqual(["one"]);
    expect(replyAddress("one", [{id:"one",name:"Plan ner"},{id:"two",name:"Planner"}])).toBeNull();
  });
  it("quotes the selected speaker segment, including repeated speakers, without tools or reasoning", () => {
    expect(replyContext(group, 0)).toEqual({ messageId: group.id, speakerIndex: 0, author: "Researcher", botId: "researcher", excerpt: "Research findings @Writer" });
    expect(replyContext(group, 6)?.excerpt).toBe("Revised findings");
    expect(replyContext(group, 4)?.excerpt).toBe("First draft");
    expect(replyContext(group)).toBeNull();
    expect(replyContext(group, 3)).toBeNull();
  });
  it("rejects references outside the authorized chat and selected branch", () => {
    const foreign = row({ ...group, id: "foreign" }, user.id, "someone-elses-chat");
    const sibling = row({ ...group, id: "sibling" }, user.id);
    for (const messageId of ["foreign", "sibling", "unknown"]) {
      expect(() => resolveReplyReference([...rows, foreign, sibling], "own-chat", group.id, { messageId, speakerIndex: 0 }, "Group")).toThrow("not in this conversation branch");
    }
    expect(() => resolveReplyReference(rows, "own-chat", null, { messageId: user.id }, "Group")).toThrow();
  });
  it("requires a current authorized group speaker and derives the quote from stored text", () => {
    expect(() => resolveReplyReference(rows, "own-chat", group.id, { messageId: group.id, speakerIndex: 4 }, "Group", new Set(["researcher"]))).toThrow("unavailable");
    expect(() => resolveReplyReference(rows, "own-chat", group.id, { messageId: group.id }, "Group", new Set(["researcher"]))).toThrow("unavailable");
    const reference = { messageId: group.id, speakerIndex: 0, author: "Forged", excerpt: "Forged", botId: "other" };
    expect(resolveReplyReference(rows, "own-chat", group.id, reference, "Group", new Set(["researcher"]))).toEqual(replyContext(group, 0));
  });
  it("supports plain user/direct replies, caps quotes, and rejects empty text", () => {
    expect(resolveReplyReference(rows, "own-chat", group.id, { messageId: user.id }, "Group")?.author).toBe("You");
    expect(replyContext({ ...group, parts: [{ type: "text", text: "x".repeat(1100) }] }, undefined, "Navigator")?.excerpt).toHaveLength(1000);
    expect(replyContext({ ...group, parts: [{ type: "reasoning", text: "Hidden" }] })).toBeNull();
  });
  it("adds model context without changing raw @mention routing text or earlier messages", async () => {
    const selected = replyContext(group, 0)!;
    const input: PortalUIMessage = { id: "reply", role: "user", parts: [{ type: "text", text: "@Researcher Please expand this" }], metadata: { replyTo: selected } };
    const prepared = await resolveAttachmentsForModel([group, input], { provider: "openai" } as AiApp, "synthetic-user");
    expect(prepared[1].parts[0]).toEqual({ type: "text", text: expect.stringContaining("> Research findings @Writer") });
    expect(prepared[1].parts[1]).toEqual(input.parts[0]);
    expect(input.parts).toHaveLength(1);
    expect(prepared[0].parts).toEqual(group.parts);
  });
});
