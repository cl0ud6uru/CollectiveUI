/** Shared, credential-free command vocabulary. Only the server decides what may execute. */
export type HermesCommand = { name: string; args?: string; description: string };

export const HERMES_COMMANDS: HermesCommand[] = [
  { name: "help", description: "Commands available in this chat" },
  { name: "status", description: "Reply state and requested / reported model" },
  { name: "usage", description: "Reported tokens for this conversation" },
  { name: "new", description: "Start a fresh session; keep this chat's history" },
  { name: "reset", description: "Alias for /new; keeps history and memory" },
  { name: "stop", description: "Cancel this chat's reply, including a pending approval" },
  { name: "yolo", args: "[status | on | off]", description: "Verify or change approvals for this remote session only (owner/admin)" },
  { name: "model", args: "[allowed-route | default]", description: "Inspect or request a model for future turns in this chat" },
  { name: "skills", description: "List installed Hermes skills (discovery only)" },
  { name: "tools", description: "List Hermes toolsets (read only)" },
];

export type SlashInput =
  | { kind: "text"; text: string; literal: boolean }
  | { kind: "command"; namespace: "hermes" | "portal"; name: string; args: string };

/** Whole leading token only: /tmp/file and prose mentioning /help remain text. // explicitly escapes a slash. */
export function parseHermesInput(text: string): SlashInput {
  const trimmed = text.trim();
  if (trimmed.startsWith("//")) return { kind: "text", text: trimmed.slice(1), literal: true };
  const match = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return { kind: "text", text, literal: false };
  const name = match[1].toLowerCase();
  const args = (match[2] ?? "").trim();
  if (name === "hermes" || name === "portal") {
    const [command = "help", ...rest] = args.split(/\s+/).filter(Boolean);
    return { kind: "command", namespace: name, name: command.toLowerCase(), args: rest.join(" ") };
  }
  return { kind: "command", namespace: "hermes", name, args };
}

export function unsupportedHermesCommand(name: string, namespace = "hermes"): string {
  if (namespace === "portal") return "Portal skills aren't available with the Hermes backend. /skills lists Hermes skills; native skill invocation is not supported yet.";
  if (["compress", "context", "undo", "retry", "rollback", "fork", "resume"].includes(name))
    return `/${name} requires native Hermes session controls that this integration doesn't expose. Use /new for a fresh session or /help for supported commands.`;
  if (["terminal", "shell", "config", "sethome", "home", "restart", "reload", "update", "cron", "plugins", "profile"].includes(name))
    return `/${name} is a native Hermes or profile-management command. This chat cannot change the shared profile or execute CLI commands.`;
  return `/${name} isn't supported here. The Hermes Runs API treats slash text as model input, so this command was not sent. Use /help, or //${name} to send literal text.`;
}

export type Discovery<T> = { available: true; items: T[] } | { available: false; reason: string };
export type HermesSkill = { name: string; description: string };
export type HermesToolset = HermesSkill & { enabled: boolean; configured: boolean };
/** A route Hermes advertises; `allowed` is the admin's decision about whether users may request it. */
export type HermesModelRoute = { id: string; allowed: boolean };

/** "openai/gpt-5" and "openai:gpt-5" group under "openai"; ids without a prefix share one group. */
export function routeProvider(id: string): string {
  const m = /^([^/:\s]+)[/:]./.exec(id);
  return m ? m[1] : "Routes";
}

export type HermesCommandCatalog = {
  backend: "hermes";
  commands: HermesCommand[];
  models: Discovery<string>;
  /** Everything Hermes advertises (not just what is allowed), so the picker can explain what is unavailable. */
  modelRoutes: HermesModelRoute[];
  skills: Discovery<HermesSkill>;
  tools: Discovery<HermesToolset>;
  canStopRemotely: boolean;
  capabilityWarning?: string;
  yolo?: { available: true; enabled: boolean } | { available: false; reason: string };
  requestedModel: string | null;
  revision: number;
};
export type CommandResult = {
  title: string;
  lines: string[];
  revision?: number;
  conversationId?: string;
  navigateTo?: string;
  refresh?: boolean;
};
