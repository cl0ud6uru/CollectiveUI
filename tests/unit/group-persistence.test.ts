import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PortalUIMessage } from "@/lib/chat/store";
const f = vi.hoisted(() => ({ engine: null as PGlite | null,
  onEnd: null as ((input: { responseMessage: PortalUIMessage }) => Promise<void>) | null }));
vi.mock("server-only", () => ({}));
vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  f.engine = new PGlite();
  return { db: drizzle(f.engine) };
});
vi.mock("ai", async original => ({ ...await original<typeof import("ai")>(), createUIMessageStream: (opts: { onEnd: typeof f.onEnd }) => {
  f.onEnd = opts.onEnd;
  return new ReadableStream({ start(controller) { controller.close(); } });
} }));
vi.mock("@/lib/settings", () => ({ getSetting: async () => ({ maxStepsCap: 6 }) }));
vi.mock("@/lib/agent/memory", () => ({ memoryEnabled: async () => false }));
vi.mock("@/lib/chat/store", async original => ({ ...await original<typeof import("@/lib/chat/store")>(), insertMessage: async () => {}, setCurrentLeaf: async () => {} }));
vi.mock("@/lib/delegation/receipts", () => ({ receiveGroupResults: async () => {} }));
import { runGroupTurn } from "@/lib/agent/group";
import { db } from "@/db";
import { toolCalls } from "@/db/schema";

beforeAll(async () => {
  await f.engine!.exec(`
    CREATE TABLE conversations (id text primary key, updated_at timestamptz);
    INSERT INTO conversations VALUES ('chat', now());
    CREATE TABLE tool_calls (id text primary key, provider_call_id text, conversation_id text, message_id text,
      run_id text, user_id text, bot_id text, tool_name text, input jsonb, output jsonb, status text, decided_by text,
      duration_ms integer, created_at timestamptz default now());
  `);
});
afterAll(async () => { await f.engine!.close(); });

describe("group tool audit persistence", () => {
  it("commits group tool input/output containing NULs and lone surrogates to PostgreSQL JSONB", async () => {
    await runGroupTurn({ principal: { user: { id: "alice" } }, conversation: { id: "chat" }, members: [], history: [] } as never);
    const message: PortalUIMessage = { id: "answer", role: "assistant", parts: [
      { type: "data-speaker", data: { botId: "researcher", name: "Researcher", avatar: null } },
      { type: "dynamic-tool", toolName: "lookup", toolCallId: "call", state: "output-available",
        input: { query: "bad\u0000input\ud800" }, output: { nested: ["result\u0000\udc00", "valid 😀"], "key\u0000": 1 } },
    ] };
    await f.onEnd!({ responseMessage: message });
    const [row] = await db.select().from(toolCalls);
    expect(row).toMatchObject({ botId: "researcher", messageId: "answer", status: "done",
      input: { query: "bad�input�" }, output: { nested: ["result��", "valid 😀"], "key�": 1 } });
    expect(message.parts[1]).toMatchObject({ input: { query: "bad\u0000input\ud800" } });
  });
});
