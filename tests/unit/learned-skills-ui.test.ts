import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(chat)/actions", () => ({ deleteMemory: vi.fn(), saveMemory: vi.fn(), setMemoryPinned: vi.fn() }));
vi.mock("@/app/(chat)/bots/actions", () => ({ deleteSkill: vi.fn(), saveSkill: vi.fn() }));
vi.mock("@/app/(chat)/bots/learning-actions", () => ({ getLearningHistory: vi.fn(), updateLearning: vi.fn() }));
vi.mock("@/components/bots/routine-editor", () => ({ RoutineEditor: () => null, RunStatusIcon: () => null, scheduleText: () => "" }));
import { BotPanels } from "@/components/bots/bot-panels";
import { LearningCard } from "@/components/bots/learning-panel";
import type { LearningView } from "@/lib/agent/learning/types";
const lesson: LearningView = {
  id: "learned", kind: "procedure", pinned: false, useCount: 2, lastUsedAt: null, stale: false,
  scope: "bot", status: "active", version: 1, canManage: true, updatedAt: new Date().toISOString(),
  content: { name: "Check group updates", description: "Assess a group", instructions: "Resolve then check", expectedOutput: "Report", boundaries: "Read only" }, verification: "Verified call",
};
const props = { botId: "bot", canEdit: true, webhookBase: "", skills: [], learned: [lesson], routines: [], runs: [], memories: [], activity: [] };
describe("one skill catalog", () => {
  it("shows a learned skill in Skills without a misleading empty state or standalone Learning heading", () => {
    const html = renderToStaticMarkup(createElement(BotPanels, props));
    expect(html).toContain("Check group updates");
    expect(html).toContain(">Learned</span>");
    expect(html).toContain(">Shared</span>");
    expect(html).not.toContain("No skills yet");
    expect(html).not.toContain(">Learning</h2>");
    expect(html).toContain(">Edit</button>");
  });
  it("keeps personal preferences out of the Skills tab", () => {
    const html = renderToStaticMarkup(createElement(BotPanels, { ...props, learned: [{ ...lesson, kind: "preference", scope: "user" }] }));
    expect(html).not.toContain("Check group updates");
  });
  it("does not append learned skills underneath service-bot Activity or native Hermes resources", () => {
    for (const mode of [{ serviceMode: true }, { native: true }]) {
      expect(renderToStaticMarkup(createElement(BotPanels, { ...props, ...mode }))).not.toContain("Check group updates");
    }
  });
  it("labels a private proposal distinctly and offers approval separately from Edit", () => {
    const html = renderToStaticMarkup(createElement(LearningCard, { row: { ...lesson, scope: "user", status: "pending" } }));
    expect(html).toContain(">Personal</span>");
    expect(html).toContain(">Needs approval</span>");
    expect(html).toContain(">Approve</button>");
    expect(html).toContain(">Edit</button>");
    expect(html).not.toContain(">Correct</button>");
  });
});
