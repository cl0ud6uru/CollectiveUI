import { HERMES_COMMANDS } from "./hermes-commands";

export type ComposerCommand = { value: string; args?: string; description: string; group: "Commands" | "Skills" };
type Skill = { slug: string; name: string; description: string };

/**
 * What the composer's "/" button lists: only what this chat can actually run. Hermes chats get the Hermes controls;
 * native bot chats get a fresh chat (not in the embedded builder preview, where it would navigate away) and their
 * skills; plain model and group chats have no slash commands.
 */
export function composerCommands({ kind, hermes, embedded = false, skills = [] }: {
  kind?: "app" | "bot" | "group"; hermes: boolean; embedded?: boolean; skills?: Skill[];
}): ComposerCommand[] {
  if (!kind || kind === "group") return [];
  if (hermes) return HERMES_COMMANDS
    .filter((c) => !embedded || (c.name !== "new" && c.name !== "reset"))
    .map((c) => ({ value: `/${c.name}`, args: c.args, description: c.description, group: "Commands" }));
  if (kind !== "bot") return [];
  return [
    ...(embedded ? [] : [
      { value: "/new", description: "Start a fresh chat with this bot; this one stays in your history", group: "Commands" as const },
      { value: "/reset", description: "Same as /new", group: "Commands" as const },
    ]),
    ...skills.map((s) => ({ value: `/${s.slug}`, description: s.description || s.name, group: "Skills" as const })),
  ];
}

/**
 * Puts a chosen command at the start of the draft without losing anything typed: a partial command being typed
 * ("/sta") is replaced, any other text is kept after the command. Nothing is sent.
 */
export function insertCommandIntoDraft(draft: string, command: string): string {
  const text = draft.replace(/^\s+/, "");
  if (!text) return `${command} `;
  const partial = /^\/(?!\/)(?:hermes\s+)?[\w-]*(?=\s|$)\s*/i.exec(text);
  const rest = partial ? text.slice(partial[0].length) : text;
  return `${command} ${rest}`;
}
