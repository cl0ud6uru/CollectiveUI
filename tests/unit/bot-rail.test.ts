import { describe, expect, it } from "vitest";
import type { ConversationSummary, TargetOption } from "@/components/chat/types";
import { botRailActivity, railNavigationBots } from "@/lib/bots/rail";

const bots: TargetOption[] = Array.from({ length: 10 }, (_, i) => ({ kind: "bot", id: `b${i}`, name: `Bot ${i}`, icon: null, description: null, pinned: i === 8, hidden: i === 0 }));
const task = (status: NonNullable<ConversationSummary["taskActivity"]>["status"], unread = false, botId = "b1"): ConversationSummary => ({ id: `${botId}-${status}`, title: "Synthetic task", pinned: false, folderId: null, botId, appId: null, source: "delegation", updatedAt: "2026-01-01", taskActivity: { status, unread } });

describe("collapsed bot rail", () => {
  it("preserves personal order, hidden preferences and pin eligibility within the available space", () => {
    const result = railNavigationBots(bots, undefined, 6);
    expect(result.visible.map(b => b.id)).toEqual(["b1", "b2", "b3", "b4", "b5", "b8"]);
    expect(result.all.map(b => b.id)).toEqual(["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9"]);
    expect(result.remaining).toBe(3);
  });
  it("keeps an active hidden or overflow bot visible without changing saved order or resurrecting revoked access", () => {
    expect(railNavigationBots(bots, "b9", 3).visible.map(b => b.id)).toEqual(["b1", "b2", "b9"]);
    expect(railNavigationBots(bots, "b0", 1).visible.map(b => b.id)).toEqual(["b0"]);
    expect(railNavigationBots(bots, "revoked", 1).all.some(b => b.id === "revoked")).toBe(false);
    expect(railNavigationBots([], "b1", 6)).toEqual({ all: [], visible: [], remaining: 0 });
  });
  it("never infers activity or unread from a preview, recent timestamp or selection", () => {
    expect(botRailActivity({ ...bots[1], preview: "Working on a new result", lastAt: new Date().toISOString() }, [])).toEqual({ approval: false, attention: false, working: false, unread: false, label: "Idle" });
    expect(botRailActivity(bots[1], [task("running", true, "b2"), { ...task("failed", true), archived: true }]).label).toBe("Idle");
  });
  it("combines real work, approval, failures and terminal unread state with attention taking precedence", () => {
    expect(botRailActivity({ ...bots[1], status: "working" }, [task("succeeded", true)])).toMatchObject({ working: true, unread: true, label: "Working" });
    expect(botRailActivity(bots[1], [task("waiting"), task("running"), task("failed", true)])).toEqual({ approval: true, attention: true, working: true, unread: true, label: "Needs your approval" });
    expect(botRailActivity(bots[1], [task("interrupted")])).toMatchObject({ attention: true, unread: false, label: "Needs attention" });
    expect(botRailActivity(bots[1], [task("succeeded", true)]).label).toBe("Unread result");
    expect(botRailActivity(bots[1], [task("succeeded", false), task("queued", true)]).label).toBe("Idle");
  });
});
