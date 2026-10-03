import { describe, expect, it } from "vitest";
import { composerCommands, insertCommandIntoDraft } from "@/lib/chat/composer-commands";
import { HERMES_COMMANDS } from "@/lib/chat/hermes-commands";

const skills = [{ slug: "weekly-report", name: "Weekly report", description: "Build the weekly status report" }];

describe('composer "/" button (#34)', () => {
  it("lists Hermes controls for Hermes chats, and never portal skills there", () => {
    const list = composerCommands({ kind: "bot", hermes: true, skills });
    expect(list.map((c) => c.value)).toEqual(HERMES_COMMANDS.map((c) => `/${c.name}`));
    expect(list.find((c) => c.value === "/model")?.args).toBe("[allowed-route | default]");
    expect(composerCommands({ kind: "app", hermes: true }).length).toBe(HERMES_COMMANDS.length);
  });

  it("lists a fresh chat and the bot's skills for native bots", () => {
    expect(composerCommands({ kind: "bot", hermes: false, skills }).map((c) => [c.value, c.group])).toEqual([
      ["/new", "Commands"], ["/reset", "Commands"], ["/weekly-report", "Skills"],
    ]);
    // The builder preview would navigate away from unsaved edits.
    expect(composerCommands({ kind: "bot", hermes: false, embedded: true, skills }).map((c) => c.value)).toEqual(["/weekly-report"]);
  });

  it("keeps navigation commands out of the Hermes builder preview too", () => {
    const list = composerCommands({ kind: "bot", hermes: true, embedded: true, skills });
    expect(list.map((c) => c.value)).not.toContain("/new");
    expect(list.map((c) => c.value)).not.toContain("/reset");
    expect(list.map((c) => c.value)).toContain("/status");
    expect(list.map((c) => c.value)).not.toContain("/weekly-report");
  });

  it("offers nothing where slash text is just a message", () => {
    expect(composerCommands({ kind: "app", hermes: false })).toEqual([]);
    expect(composerCommands({ kind: "group", hermes: false, skills })).toEqual([]);
    expect(composerCommands({ kind: undefined, hermes: false })).toEqual([]);
  });

  it("choosing a command keeps the draft and sends nothing", () => {
    expect(insertCommandIntoDraft("", "/status")).toBe("/status ");
    expect(insertCommandIntoDraft("  ", "/status")).toBe("/status ");
    expect(insertCommandIntoDraft("summarize last week", "/weekly-report")).toBe("/weekly-report summarize last week");
    expect(insertCommandIntoDraft("/sta", "/status")).toBe("/status ");
    expect(insertCommandIntoDraft("/", "/help")).toBe("/help ");
    expect(insertCommandIntoDraft("/hermes mod", "/model")).toBe("/model ");
    expect(insertCommandIntoDraft("/weekly-report for finance", "/new")).toBe("/new for finance");
    // Paths and escaped slashes are text, not a command being typed.
    expect(insertCommandIntoDraft("/tmp/log is empty", "/help")).toBe("/help /tmp/log is empty");
    expect(insertCommandIntoDraft("//literal", "/help")).toBe("/help //literal");
  });
});
