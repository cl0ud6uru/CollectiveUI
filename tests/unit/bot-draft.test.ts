import { APICallError, NoObjectGeneratedError, RetryError } from "ai";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/authz";
import {
  botDraftInstructions,
  botDraftSchema,
  cleanStarters,
  describeDraftFailure,
  finalizeDraft,
  INCOMPLETE_DRAFT,
  isAssistantVoiceStarter,
  PROVIDER_REJECTED,
  STARTERS_DESCRIPTION,
  type BotDraft,
} from "@/lib/bots/draft";
import { ChatGPTNotConnectedError } from "@/lib/llm/chatgpt/errors";

const tools = [
  { key: "web_search", label: "Web search", description: "Search the public web." },
  { key: "memory", label: "Memory", description: "Remember facts." },
];
const draft = (over: Partial<BotDraft> = {}): BotDraft => ({
  name: "Helper", label: "Helper", description: "Helps.", instructions: "- Help", boundaries: "None", starters: [], tools: [], ...over,
});

describe("conversation starters are written by the user", () => {
  // Reported on the bot designer (issue #32): these read backwards once clicking sends them as the user.
  const reported = [
    "Need a hand drafting or polishing something?",
    "Want me to find a company document or answer a work question?",
    "I can summarize this, pull out action items, or explain it—what would help?",
  ];
  const userRequests = ["Help me draft an email.", "Find a company document.", "Summarize this and list the action items.", "What's our travel policy?", "Can you review this contract?", "I can't find the VPN guide.", "I'm travelling to Berlin. What should I pack?", "Let me know the holiday schedule.", "Need a summary of this document."];

  it("drops greetings, offers and answers in the bot's voice", () => {
    for (const s of [...reported, "Hi! How can I help today?", "Hello there", "Shall I check your calendar?", "Would you like a summary?", "I'll draft it for you."])
      expect(isAssistantVoiceStarter(s), s).toBe(true);
    expect(cleanStarters(reported)).toEqual([]);
  });

  it("keeps requests a person would send", () => {
    for (const s of userRequests) expect(isAssistantVoiceStarter(s), s).toBe(false);
    expect(cleanStarters(userRequests)).toEqual(userRequests.slice(0, 4));
  });

  it("trims, unquotes, de-duplicates and bounds them", () => {
    expect(cleanStarters(["  “Help me   draft an email.” ", "help me draft an email.", "", "x".repeat(400), "Find a document."])).toEqual(["Help me draft an email.", "Find a document."]);
  });

  it("tells the model starters are user messages and lists only offered tools", () => {
    expect(STARTERS_DESCRIPTION).toMatch(/USER's first message/);
    expect(STARTERS_DESCRIPTION).toMatch(/Never write them in the bot's voice/);
    const instructions = botDraftInstructions(tools);
    expect(instructions).toMatch(/written by the user, not the bot/);
    expect(instructions).toContain("web_search");
    expect(instructions).not.toContain("workspace");
    expect(botDraftInstructions([])).toMatch(/can only chat/);
  });

  it("the schema only accepts offered tools", () => {
    const schema = botDraftSchema(tools);
    expect(schema.safeParse(draft({ tools: ["memory"] })).success).toBe(true);
    expect(schema.safeParse(draft({ tools: ["workspace"] })).success).toBe(false);
    expect(botDraftSchema([]).safeParse(draft({ tools: ["memory"] })).success).toBe(false);
    expect(botDraftSchema([]).safeParse(draft()).success).toBe(true);
  });

  it("finalizes a parsed draft: in-voice starters only, offered unique tools only", () => {
    const out = finalizeDraft(draft({ starters: [reported[0], "Help me draft an email."], tools: ["memory", "memory", "workspace"] }), tools);
    expect(out.starters).toEqual(["Help me draft an email."]);
    expect(out.tools).toEqual(["memory"]);
  });
});

describe("drafting failures become safe, actionable messages", () => {
  const apiError = (statusCode: number) =>
    new APICallError({ message: "upstream said sk-proj-SHOULDNOTAPPEAR0000000000", url: "https://x", requestBodyValues: { prompt: "secret prompt" }, statusCode, responseBody: "raw provider body" });

  it("passes through messages written for people", () => {
    expect(describeDraftFailure(new HttpError(400, "Describe the bot first."))).toEqual({ ok: false, error: "Describe the bot first." });
    expect(describeDraftFailure(new ChatGPTNotConnectedError()).error).toMatch(/Connect your ChatGPT account/);
    expect(describeDraftFailure(new HttpError(401, "Unauthorized")).error).toMatch(/session has expired/);
  });

  it("reports provider rejections and malformed output with a reference, logging details server-side only", () => {
    const log = vi.fn();
    const rejected = describeDraftFailure(new RetryError({ message: "retries", reason: "maxRetriesExceeded", errors: [apiError(400)] }), log);
    expect(rejected.error.startsWith(PROVIDER_REJECTED)).toBe(true);
    expect(rejected.reference).toMatch(/^\w{8}$/);
    expect(rejected.error).toContain(rejected.reference);
    for (const leaked of ["SHOULDNOTAPPEAR", "raw provider body", "secret prompt"]) expect(rejected.error).not.toContain(leaked);
    expect(log).toHaveBeenCalledWith("[bots] draft failed", expect.objectContaining({ reference: rejected.reference, kind: "provider", status: 400 }));
    expect(JSON.stringify(log.mock.calls)).not.toContain("sk-proj-SHOULDNOTAPPEAR");

    const malformed = describeDraftFailure(new NoObjectGeneratedError({ message: "No object generated", text: '{"name":"Ha', response: undefined as never, usage: undefined as never, finishReason: "length" }), log);
    expect(malformed.error.startsWith(INCOMPLETE_DRAFT)).toBe(true);
  });

  it("keeps unexpected internals out of the browser", () => {
    const log = vi.fn();
    const err = new Error("relation \"bots\" does not exist at /srv/app/node_modules/pg");
    const out = describeDraftFailure(err, log);
    expect(out.error).toMatch(/^Something went wrong while drafting\. Try again\. \(Reference \w{8}\)$/);
    expect(out.error).not.toContain("relation");
    expect(log.mock.calls[0][1]).toMatchObject({ kind: "unexpected" });
    expect(describeDraftFailure(new HttpError(500, "internal detail"), log).error).not.toContain("internal detail");
  });
});
