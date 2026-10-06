import type { SystemModelMessage } from "ai";
import type { AiApp, Bot, Skill } from "@/db/schema";
import type { InstructionStyle } from "@/lib/llm";
import type { MemoryRow } from "./memory";

/**
 * Instructions are built as sections. "stable" sections stay the same across a conversation's turns (persona,
 * job, skills, team); "dynamic" ones change per turn (memories picked for the query, the current time).
 * Stable-first ordering and Anthropic prompt caching use this split; OpenAI-compatible apps get the same single
 * string as before.
 */
export type InstructionSection = { kind: "stable" | "dynamic"; text: string };

export type InstructionOptions = {
  app: AiApp;
  bot: Bot | null;
  userName: string;
  customInstructions?: string;
  memories: MemoryRow[];
  skills: Skill[];
  delegates: Bot[];
  /** A routine's first segment or a delegated task: adds the "Background run" note. */
  background: boolean;
  coordinator?: boolean;
  delegatedBy?: string;
  /** The workspace's description, when the bot has workspace tools. */
  workspace?: string;
  now?: Date;
};

export function buildInstructionSections(opts: InstructionOptions): InstructionSection[] {
  const { app, bot } = opts;
  const now = opts.now ?? new Date();
  const out: InstructionSection[] = [];
  const stable = (text: string) => out.push({ kind: "stable", text });
  const dynamic = (text: string) => out.push({ kind: "dynamic", text });

  if (bot) {
    stable(`You are "${bot.name}", an AI teammate at the user's company.`);
    if (bot.description) stable(`## Your job\n${bot.description}`);
    if (bot.instructions) stable(`## Instructions\n${bot.instructions}`);
    if (bot.boundaries) stable(`## Boundaries (never cross these)\n${bot.boundaries}`);
    stable(
      "## Working style\n- Use your tools when they help; don't guess facts you can look up.\n- When a tool call is denied by the user, do not retry it — explain what you would have done instead.\n- Before sensitive actions (sending messages, changing data) make sure you have the details right.",
    );
  } else if (app.systemPrompt) {
    stable(app.systemPrompt);
  } else {
    stable("You are a helpful AI assistant for employees of the user's company.");
  }
  if (bot && app.systemPrompt) stable(`## Platform guidance\n${app.systemPrompt}`);

  if (opts.skills.length) {
    stable(
      "## Skills\nYou have saved skills (proven procedures). When a request matches one, call `use_skill` first and follow it:\n" +
        opts.skills.map((s) => `- ${s.slug}: ${s.description}`).join("\n"),
    );
  }
  if (opts.coordinator) {
    stable("## Coordination\nPlan assignments using only the specialist tools offered in this turn. A successful tool call records an assignment; only a completed result establishes completed work. Use the supported sync or async mode and report its actual status. Async assignments resume this reply after their results arrive; do not promise unsupported scheduled followups. Synthesize returned evidence and explain blocked actions. Never imply access to another person's conversations or accounts.");
  }
  if (opts.delegates.length) {
    stable(
      "## Your team\nYou coordinate specialist bots. Start new work with the matching `ask_*` tool, then combine their results. For a follow-up on the same piece of work, use the specialist's `continue_*` tool when offered, passing the exact taskId from the earlier assignment. This retains its context and task conversation, even after completion. Busy follow-ups queue; report queued/working until the new result completes. Each call has its own taskId and result: never treat an earlier completion as completion of a new follow-up. Unrelated work always starts a new task, even with the same specialist. Do not guess IDs or automatically retry failed/stopped work; earlier actions may have run.\n" +
        opts.delegates.map((d) => `- ${d.name}: ${d.description ?? ""}`).join("\n"),
    );
  }
  if (opts.workspace) {
    stable(
      `## Workspace\n${opts.workspace}\n` +
        "- Paths are relative to /home/agent/workspace. Look around with workspace_list, workspace_read and workspace_grep before changing things.\n" +
        "- The user approves every command (workspace_bash) and file change, so batch related steps into one command and explain what it does.\n" +
        "- Change files with workspace_edit (exact text) or workspace_write (whole files). There is no network: nothing can be downloaded or installed.",
    );
  }
  if (opts.memories.length) {
    dynamic(
      "## What you remember about the user\n" +
        opts.memories.map((m) => `- (${m.id}) ${m.content}`).join("\n") +
        "\nUse this context naturally; don't recite it.",
    );
  }
  if (opts.customInstructions?.trim()) {
    stable(`## The user's custom instructions\n${opts.customInstructions.trim()}`);
  }
  if (opts.delegatedBy) {
    stable(`## Delegated task\n${opts.delegatedBy} assigned this task on behalf of the user. Complete the supplied task and return your result to the assigning bot. This is separate from your home chat. Durable native workspace actions pause for the owning human's approval in the originating and task chats. The assigning bot cannot approve for the human. If another action is denied, explain the blocked action; never retry it to bypass approval.`);
  } else if (opts.background) {
    stable(
      "## Background run\nYou are running a scheduled routine with no one watching live. Complete the task end to end and finish with a concise report of what you did and anything that needs the user's attention.",
    );
  }
  dynamic(`The user's name is ${opts.userName}. Current date and time: ${now.toISOString()} (UTC).`);
  stable("Format answers with Markdown when helpful (headings, lists, tables, fenced code blocks with a language).");
  return out;
}

export const joinSections = (sections: InstructionSection[]) => sections.map((s) => s.text).join("\n\n");

/** The instructions as one string, in the original order. */
export function buildInstructions(opts: InstructionOptions): string {
  return joinSections(buildInstructionSections(opts));
}

/**
 * Shapes instruction sections for a model:
 *  - legacy (OpenAI-compatible): one string in the original order, exactly as before.
 *  - stable-first: one string, stable sections first so automatic prefix caching can reuse them.
 *  - anthropic-cache: two system blocks; the stable one carries an Anthropic cache breakpoint.
 */
export function toModelInstructions(sections: InstructionSection[], style: InstructionStyle): string | SystemModelMessage[] {
  if (style === "legacy") return joinSections(sections);
  const stableText = joinSections(sections.filter((s) => s.kind === "stable"));
  const dynamicText = joinSections(sections.filter((s) => s.kind === "dynamic"));
  if (style === "stable-first") return [stableText, dynamicText].filter(Boolean).join("\n\n");
  const blocks: SystemModelMessage[] = [
    { role: "system", content: stableText, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
  ];
  // Anthropic rejects empty text blocks.
  if (dynamicText) blocks.push({ role: "system", content: dynamicText });
  return blocks;
}
