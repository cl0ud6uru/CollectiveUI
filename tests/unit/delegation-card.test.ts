import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/app/(chat)/settings/workspace-actions", () => ({ stopWorkspaceCommand: async () => ({ ok: true }) }));
import { DelegationCard } from "@/components/chat/tool-part";
import { PetProvider } from "@/components/pets/pet-context";
import { DEFAULT_PET } from "@/lib/pets/shared";

type Output = Parameters<typeof DelegationCard>[0]["output"];
const base: Output = { taskId: "task-1", conversationId: "conv-1", bot: "Gemma 4", botId: "bot-gemma", avatar: "blob:circle:teal", label: "Mac Mini", status: "working", steps: [] };
const card = (output: Partial<Output>) => renderToStaticMarkup(createElement(DelegationCard, { output: { ...base, ...output } }));

describe("delegation card", () => {
  it("shows the working delegate inside the card with its steps collapsed", () => {
    const html = card({ status: "working", steps: [{ tool: "web_search", status: "done" }, { tool: "fetch_url", status: "running" }] });
    expect(html).toContain('data-delegation-card="working"');
    expect(html).toContain("Gemma 4 is working…");
    expect(html).toContain("animate-spin");
    expect(html).toContain('data-bot-avatar="bot-gemma"');
    expect(html).toContain('data-activity="working"');
    expect(html).not.toContain("delegate-bob");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("2 steps");
    expect(html).not.toContain("Searched the web");
    expect(html).not.toContain("replied in");
  });

  it("renders a finished answer as markdown with host, reply time and an Open task link", () => {
    const html = card({ status: "done", answer: "**Still kicking!** Alive and well.", startedAt: "2026-10-06T12:00:00.000Z", finishedAt: "2026-10-06T12:00:04.200Z", steps: [{ tool: "web_search", status: "done" }] });
    expect(html).toContain('data-delegation-card="done"');
    expect(html).toContain("<strong>Still kicking!</strong> Alive and well.");
    expect(html).not.toMatch(/[“"]Still kicking/);
    expect(html).toContain("Mac Mini · replied in 4s");
    expect(html).toContain('href="/c/conv-1"');
    expect(html).toContain("Open task");
    expect(html).toContain("delegate-bob");
    expect(html).toContain("1 step");
    expect(html).not.toContain("is working");
  });

  it("omits the reply time without recorded times and falls back to the name initial without a bot id", () => {
    const html = card({ status: "done", answer: "Done.", botId: undefined, avatar: undefined, label: null, conversationId: null, steps: [] });
    expect(html).not.toContain("replied in");
    expect(html).not.toContain("data-bot-avatar");
    expect(html).toMatch(/>G<\/span>/);
    expect(html).not.toContain("Open task");
    expect(html).not.toContain("step");
    expect(card({ status: "done", answer: "Done." })).toContain(">Mac Mini<");
  });

  it("keeps queued and error states inside the card with their current copy", () => {
    const queued = card({ status: "queued" });
    expect(queued).toContain('data-delegation-card="queued"');
    expect(queued).toContain("Scheduled independently. This reply will continue when the task returns.");
    expect(queued).not.toContain("is working");

    const failed = card({ status: "error", error: "The delegated task deadline expired." });
    expect(failed).toContain('data-delegation-card="error"');
    expect(failed).toContain('class="text-danger">The delegated task deadline expired.</div>');
    expect(failed).not.toContain("animate-spin");
    expect(failed).not.toContain("steps");
  });

  it.each([
    "The assignment is no longer authorized to return a result.",
    "The assignment has no authorized, committed result in this chat.",
  ])("renders a sanitized result without receiver identity: %s", (error) => {
    // Receipt validation deliberately strips identity and links from rejected outputs.
    const html = renderToStaticMarkup(createElement(DelegationCard, { output: { status: "error", error } }));
    expect(html).toContain(error);
    expect(html).toContain("Delegated task");
    expect(html).toMatch(/>\?<\/span>/);
    expect(html).not.toContain("Open task");
    expect(html).not.toContain("data-bot-avatar");
  });

  it.each(["still", "auto"] as const)("respects the receiver's %s motion preference", (motion) => {
    const html = renderToStaticMarkup(createElement(PetProvider, {
      initialPets: { "bot-gemma": { ...DEFAULT_PET, enabled: true, motion } },
    }, createElement(DelegationCard, { output: { ...base, status: "done", answer: "Done." } })));
    if (motion === "still") {
      expect(html).toContain('data-still="true"');
      expect(html).not.toContain("delegate-bob");
    } else {
      expect(html).toContain("delegate-bob");
    }
  });
});
