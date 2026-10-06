import type { Tool } from "ai";
import type { AiApp, ApprovalMode, Bot } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import type { PortalWorkspace } from "@/lib/sandbox/session";
import type { UsageScope } from "@/lib/llm";
import type { ToolSettings } from "@/lib/settings";

export type AgentCtx = {
  principal: Principal;
  conversationId: string;
  bot: Bot | null;
  app: AiApp;
  /** delegation depth (0 = top-level) */
  depth: number;
  delegationPath?: import("@/lib/delegation/source").DelegationEdge[];
  /** Group speakers share a message; namespace provider call ids per speaker invocation. */
  toolCallPrefix?: string;
  taskId?: string;
  execution?: { holder: string; deadlineAt: number; segment?: number };
  /** Available only in a durable native turn. Registering a task suspends at the next completed model step. */
  awaitTask?: (taskId: string) => void;
  /** Native durable children can relay workspace requests to their human owner. Never a bot approval grant. */
  relayWorkspaceApproval?: boolean;
  /**
   * A routine's first segment (nobody watching live): the instructions say so, personal plans refuse unless an admin
   * allows it, and no memories are extracted. Routine continuations (after an Inbox approval) aren't background.
   */
  background: boolean;
  /** running inside a group chat (approval requests can't pause a multi-bot turn) */
  inGroup?: boolean;
  toolSettings: ToolSettings;
  nativeSearchMode?: import("@/lib/native-search-policy").NativeSearchMode | null;
  /** Usage ledger scope of the turn; each child task has its own assistant message and run. */
  usage?: UsageScope;
  /** The acting person's workspace for this turn, shared with delegates (created by the first toolset that needs it). */
  workspace?: PortalWorkspace;
};

/** What the approval policy knows about an MCP tool (from the server's accepted snapshot and admin policy). */
export type McpApprovalFacts = {
  /** the tool's name on the server */
  tool: string;
  definitionHash?: string;
  readOnly: boolean;
  destructive: boolean;
  /** the admin marked the server trusted, so its readOnlyHint is believed */
  trusted: boolean;
  /** the admin requires approval for this tool (like enforced: "Always allow" doesn't apply) */
  requireApproval: boolean;
  /** the bot's per-tool approval, overriding the server group's */
  override?: ApprovalMode;
};

export type ToolEntry = {
  name: string; // name the model sees
  key: string; // tool group key stored in bot_tools (e.g. "web_search", "mcp:<id>")
  tool: Tool;
  sensitive?: boolean;
  /** false: every call asks, "Always allow" doesn't apply (workspace commands) */
  grantable?: boolean;
  mcp?: McpApprovalFacts;
  validateInput?: (input: unknown) => void;
};

/** Built-in tool groups a bot can enable (MCP servers and delegates are added dynamically). */
export const BUILTIN_TOOLS: { key: string; label: string; description: string; defaultApproval: ApprovalMode }[] = [
  { key: "openai_web_search", label: "OpenAI native search", description: "Let a supported OpenAI API model search when needed. Chats can switch it off.", defaultApproval: "auto" },
  { key: "web_search", label: "Web search (external)", description: "Search with your administrator's SearXNG, Brave or Bing provider.", defaultApproval: "auto" },
  { key: "fetch_url", label: "Read web pages", description: "Fetch and read the text of a URL.", defaultApproval: "auto" },
  { key: "knowledge", label: "Knowledge files", description: "Search the files attached to this bot.", defaultApproval: "auto" },
  { key: "memory", label: "Memory", description: "Remember and forget facts about the user across chats.", defaultApproval: "auto" },
  { key: "skills", label: "Skills", description: "Load saved step-by-step procedures.", defaultApproval: "auto" },
  { key: "m365", label: "Microsoft 365", description: "Search your mail, calendar and files; send mail (always asks).", defaultApproval: "auto" },
  {
    key: "workspace",
    label: "Workspace",
    description: "Run commands and edit files in each person's own offline sandbox. Commands always ask; file changes ask unless always allowed.",
    defaultApproval: "auto",
  },
];
