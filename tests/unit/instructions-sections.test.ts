import { describe, expect, it } from "vitest";
import type { AiApp, Bot } from "@/db/schema";
import { buildInstructions, buildInstructionSections, joinSections, toModelInstructions } from "@/lib/agent/instructions";

const now = new Date("2026-09-25T12:00:00Z");
const app = { systemPrompt: "Be precise." } as AiApp;
const bot = { name: "Helper", description: "Helps.", instructions: "Do things.", boundaries: "Never delete." } as Bot;
const opts = {
  app,
  bot,
  userName: "Alice",
  customInstructions: "Answer briefly.",
  memories: [{ id: "m1", content: "Likes tea", pinned: false, botId: null }],
  skills: [],
  delegates: [],
  background: false,
  now,
};

describe("instruction sections", () => {
  it("builds the same single string as before (original order)", () => {
    expect(buildInstructions(opts)).toBe(
      [
        'You are "Helper", an AI teammate at the user\'s company.',
        "## Your job\nHelps.",
        "## Instructions\nDo things.",
        "## Boundaries (never cross these)\nNever delete.",
        "## Working style\n- Use your tools when they help; don't guess facts you can look up.\n- When a tool call is denied by the user, do not retry it — explain what you would have done instead.\n- Before sensitive actions (sending messages, changing data) make sure you have the details right.",
        "## Platform guidance\nBe precise.",
        "## What you remember about the user\n- (m1) Likes tea\nUse this context naturally; don't recite it.",
        "## The user's custom instructions\nAnswer briefly.",
        "The user's name is Alice. Current date and time: 2026-09-25T12:00:00.000Z (UTC).",
        "Format answers with Markdown when helpful (headings, lists, tables, fenced code blocks with a language).",
      ].join("\n\n"),
    );
  });

  it("legacy style is the joined string; stable-first moves per-turn sections last", () => {
    const sections = buildInstructionSections(opts);
    expect(toModelInstructions(sections, "legacy")).toBe(joinSections(sections));
    const s = toModelInstructions(sections, "stable-first") as string;
    expect(s.indexOf("Format answers")).toBeLessThan(s.indexOf("What you remember"));
    expect(s.endsWith("(UTC).")).toBe(true);
  });

  it("anthropic-cache puts a cache breakpoint on the stable block only", () => {
    const blocks = toModelInstructions(buildInstructionSections(opts), "anthropic-cache") as { content: string; providerOptions?: object }[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0].providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
    expect(blocks[0].content).not.toContain("Current date");
    expect(blocks[1].providerOptions).toBeUndefined();
    expect(blocks[1].content).toContain("Likes tea");
  });

  it("a background run (a routine's first segment) gets the Background run note, as a stable section", () => {
    expect(buildInstructions(opts)).not.toContain("## Background run");
    const sections = buildInstructionSections({ ...opts, background: true });
    const note = sections.find((s) => s.text.startsWith("## Background run"));
    expect(note).toEqual({ kind: "stable", text: expect.stringContaining("You are running a scheduled routine with no one watching live.") });
  });

  it("omits an empty dynamic block", () => {
    const blocks = toModelInstructions([{ kind: "stable", text: "only" }], "anthropic-cache");
    expect(blocks).toHaveLength(1);
  });
});
