import { APICallError, NoObjectGeneratedError, NoOutputGeneratedError, RetryError, TypeValidationError, JSONParseError } from "ai";
import { z } from "zod";
import { HttpError } from "@/lib/authz";
import { newId } from "@/lib/ids";
import { userFacingMessage } from "@/lib/llm/chatgpt/errors";
import { redactSecrets } from "@/lib/redact";

/** Bounded so a draft always fits BotInput (starters ≤ 300 characters, at most 6). */
export const DRAFT_STARTER_LIMIT = 4;
export const DRAFT_STARTER_MAX_LENGTH = 160;
export const DRAFT_DESCRIPTION_MAX_LENGTH = 4000;

export type DraftTool = { key: string; label: string; description: string };

export const STARTERS_DESCRIPTION =
  "Up to four conversation starters. A starter is shown as a suggestion in a new chat and clicking it sends it, word for word, " +
  "as the USER's first message to this bot. Write each one as a short request or question a person would type to the bot, " +
  "e.g. \"Help me draft an email to a customer.\", \"Find our travel policy.\", \"Summarize this and list the action items.\" " +
  "Never write them in the bot's voice: no greetings, offers or answers such as \"Need a hand…?\", \"Want me to…?\" or \"I can…\". " +
  "Only ask for things this bot can actually do with its job and the tools you selected.";

export function botDraftInstructions(tools: DraftTool[]): string {
  const toolList = tools.length ? tools.map((t) => `- ${t.key}: ${t.label}. ${t.description}`).join("\n") : "- (none: the bot can only chat)";
  return [
    "You design AI teammates (bots) for an internal company portal. Given a description, produce a concise, practical bot configuration.",
    "Choose only tools from this list; they are the only ones available to this bot:",
    toolList,
    "Conversation starters are written by the user, not the bot: each one is exactly what a person would send to the bot to start a chat. " +
      "Do not promise tools, systems or data the bot does not have.",
  ].join("\n");
}

export function botDraftSchema(tools: DraftTool[]) {
  const keys = tools.map((t) => t.key);
  return z.object({
    name: z.string(),
    label: z.string().describe("2-3 word role tag, e.g. 'Inbox triage'"),
    description: z.string().describe("one or two sentences: the bot's job"),
    instructions: z.string().describe("detailed working instructions, as a bulleted list"),
    boundaries: z.string().describe("things the bot must never do"),
    starters: z.array(z.string()).max(DRAFT_STARTER_LIMIT).describe(STARTERS_DESCRIPTION),
    // An empty enum is invalid JSON Schema; with no tools available the model can only return [].
    tools: (keys.length ? z.array(z.enum(keys as [string, ...string[]])) : z.array(z.string()).max(0)).describe("helpful tools from the list"),
  });
}
export type BotDraft = z.infer<ReturnType<typeof botDraftSchema>>;

/**
 * Starters in the assistant's voice read backwards once clicked (the click sends them as the user). Models still slip
 * into greetings and offers despite the schema description, so drop those rather than save a reversed suggestion.
 */
const ASSISTANT_VOICE = [
  /^(hi|hello|hey|greetings|welcome)\b/i,
  /^(would you like|shall i|should i|can i|may i|how can i|how may i|what can i)\b/i,
  /^(i can|i could|i'll|i will)\s/i,
  // "Need a hand…?" offers; "Need a summary of this." stays a request.
  /^(need|want)\b.*\?$/i,
  /\b(want|would you like) me to\b/i,
  /\bwhat would help\b/i,
  /\bhow can i (help|assist)\b/i,
];
export const isAssistantVoiceStarter = (text: string) => ASSISTANT_VOICE.some((re) => re.test(text.trim()));

export function cleanStarters(starters: string[]): string[] {
  const seen = new Set<string>();
  return starters
    .map((s) => s.replace(/\s+/g, " ").trim().replace(/^["“'](.*)["”']$/, "$1").trim())
    .filter((s) => s && s.length <= DRAFT_STARTER_MAX_LENGTH && !isAssistantVoiceStarter(s))
    .filter((s) => !seen.has(s.toLowerCase()) && !!seen.add(s.toLowerCase()))
    .slice(0, DRAFT_STARTER_LIMIT);
}

/** Keeps only offered tools and in-voice starters; everything else comes from the validated schema output. */
export function finalizeDraft(draft: BotDraft, tools: DraftTool[]): BotDraft {
  const offered = new Set(tools.map((t) => t.key));
  return { ...draft, starters: cleanStarters(draft.starters), tools: [...new Set(draft.tools)].filter((k) => offered.has(k)) };
}

// Results carry friendly errors instead of throwing: production builds hide thrown server action messages.
export type BotDraftResult = { ok: true; draft: BotDraft } | { ok: false; error: string; reference?: string };

export const NO_UTILITY_MODEL =
  "Drafting needs a utility model, and none is available. Ask an administrator to choose one in Admin → Bots & tools → Utility model, then try again. Your description is kept.";
export const INCOMPLETE_DRAFT = "The utility model returned an incomplete draft. Try again, or add a little more detail to your description.";
export const PROVIDER_REJECTED =
  "The utility model couldn't draft this bot right now. Try again in a moment; if it keeps failing, ask an administrator to check the utility model connection.";

/**
 * Maps a drafting failure to a safe message. Provider responses, prompts and stacks stay in the server log, tagged
 * with a reference the person can quote.
 */
export function describeDraftFailure(err: unknown, log: (message: string, detail: Record<string, unknown>) => void = (m, d) => console.error(m, d)): Extract<BotDraftResult, { ok: false }> {
  const inner = RetryError.isInstance(err) ? err.lastError : err;
  const friendly = userFacingMessage(inner);
  if (friendly) return { ok: false, error: friendly };
  if (inner instanceof HttpError && inner.status === 401) return { ok: false, error: "Your session has expired. Sign in again, then try again." };
  if (inner instanceof HttpError && inner.status < 500) return { ok: false, error: inner.message };
  const reference = newId().slice(0, 8);
  const kind = NoObjectGeneratedError.isInstance(inner) || NoOutputGeneratedError.isInstance(inner) || TypeValidationError.isInstance(inner) || JSONParseError.isInstance(inner)
    ? "malformed" : APICallError.isInstance(inner) ? "provider" : "unexpected";
  log("[bots] draft failed", {
    reference, kind,
    status: APICallError.isInstance(inner) ? inner.statusCode : undefined,
    error: redactSecrets(inner instanceof Error ? `${inner.name}: ${inner.message}` : String(inner)).slice(0, 500),
  });
  const message = kind === "malformed" ? INCOMPLETE_DRAFT : kind === "provider" ? PROVIDER_REJECTED : "Something went wrong while drafting. Try again.";
  return { ok: false, error: `${message} (Reference ${reference})`, reference };
}
