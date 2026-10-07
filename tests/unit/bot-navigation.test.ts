import { describe, expect, it } from "vitest";
import { changeBotNavigation, orderBots, visibleNavigationBots } from "@/lib/bots/navigation";

const roster = ["Alpha", "Bravo", "Charlie"].map((name, i) => ({ id: String(i), name, pinned: false, hidden: false }));
const ids = (bots: typeof roster) => bots.map(b => b.id);
describe("personal bot navigation", () => {
  it("preserves saved order across name and activity updates, ignoring stale and duplicate IDs", () => {
    const updated = roster.map(b => ({ ...b, name: `${2 - Number(b.id)}`, status: "working", lastAt: new Date().toISOString() }));
    expect(ids(orderBots(updated, ["2", "gone", "2", "0", "1"]))).toEqual(["2", "0", "1"]);
  });
  it("initializes a stable order and appends newly accessible bots without disturbing it", () => {
    expect(ids(orderBots([{ ...roster[0], coordinator: true }, roster[1], { ...roster[2], pinned: true }]))).toEqual(["2", "0", "1"]);
    expect(ids(orderBots(roster, ["2", "0"]))).toEqual(["2", "0", "1"]);
  });
  it("inserts new pins after existing pins, unhides them, and repeated pins are idempotent", () => {
    const first = changeBotNavigation(roster, { kind: "preference", botId: "1", pinned: true });
    const next = changeBotNavigation(first, { kind: "preference", botId: "2", pinned: true });
    expect(ids(next)).toEqual(["1", "2", "0"]);
    expect(changeBotNavigation(next, { kind: "preference", botId: "2", pinned: true })).toEqual(next);
    expect(changeBotNavigation([{ ...roster[0], hidden: true }], { kind: "preference", botId: "0", pinned: true })[0]).toMatchObject({ pinned: true, hidden: false });
  });
  it("moves within pins, preserving pin state and every other relative position", () => {
    const bots = roster.map(b => ({ ...b, pinned: true }));
    const moved = changeBotNavigation(bots, { kind: "move", botId: "2", targetId: "0", placement: "before" });
    expect(ids(moved)).toEqual(["2", "0", "1"]);
    expect(moved[1].pinned).toBe(true);
    expect(ids(changeBotNavigation(moved, { kind: "move", botId: "2", targetId: "1", placement: "after" }))).toEqual(["0", "1", "2"]);
  });
  it("ignores cancelled/invalid moves and never invents inaccessible bots", () => {
    for (const targetId of ["0", "inaccessible"]) expect(changeBotNavigation(roster, { kind: "move", botId: "0", targetId, placement: "before" })).toBe(roster);
    expect(changeBotNavigation(roster, { kind: "preference", botId: "inaccessible", pinned: true })).toBe(roster);
    expect(changeBotNavigation([{ ...roster[0], hidden: true }, roster[1]], { kind: "move", botId: "0", targetId: "1", placement: "before" })[0].hidden).toBe(true);
  });
  it("limits unpinned rows but keeps every pin, the active bot and the just-moved bot", () => {
    const many = ["A", "B", "C", "D", "E", "F", "G", "H"].map((name, i) => ({ id: `m${i}`, name, pinned: i === 7, hidden: i === 0 }));
    // Filtering retains the supplied presentation order; orderBots puts pins first before this step.
    expect(ids(visibleNavigationBots(many))).toEqual(["m1", "m2", "m3", "m4", "m5", "m7"]);
    expect(ids(visibleNavigationBots(many, "m6"))).toEqual(["m1", "m2", "m3", "m4", "m5", "m6", "m7"]);
    expect(ids(visibleNavigationBots(many, "m0"))).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m7"]);
    expect(ids(visibleNavigationBots(many, "m1"))).toEqual(["m1", "m2", "m3", "m4", "m5", "m7"]);
    // Moving the fifth unpinned row down pushes it past the limit; it stays mounted so focus can return to it.
    const moved = changeBotNavigation(many, { kind: "move", botId: "m5", targetId: "m6", placement: "after" });
    expect(ids(visibleNavigationBots(moved, undefined, "m5"))).toEqual(["m1", "m2", "m3", "m4", "m6", "m5", "m7"]);
    expect(ids(visibleNavigationBots(moved))).toEqual(["m1", "m2", "m3", "m4", "m6", "m7"]);
    // A just-moved bot that was then hidden is not kept.
    expect(ids(visibleNavigationBots(many, undefined, "m0"))).not.toContain("m0");
  });
  it("hides only explicit hidden bots in a short roster", () => {
    const bots = [...roster, { id: "3", name: "Delta", pinned: true, hidden: false }];
    expect(ids(visibleNavigationBots(bots))).toEqual(["0", "1", "2", "3"]);
    const hidden = changeBotNavigation(bots, { kind: "preference", botId: "3", hidden: true });
    expect(hidden[3].pinned).toBe(false);
    expect(ids(visibleNavigationBots(hidden))).toEqual(["0", "1", "2"]);
    expect(ids(visibleNavigationBots(hidden, "3"))).toEqual(["0", "1", "2", "3"]);
  });
});
