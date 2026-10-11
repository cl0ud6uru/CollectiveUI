import { describe, expect, it } from "vitest";
import { emptyGroupSelection, groupMemberOrder, groupSelectionReducer as reduce, type GroupSelection } from "@/lib/group-selection";

const selected: GroupSelection = { picked: ["research", "writer", "planner"], leadId: "writer" };

describe("explicit group lead", () => {
  it("requires an explicit choice, independently of member click order", () => {
    const state = reduce(reduce(emptyGroupSelection, { type: "toggle", id: "research" }), { type: "toggle", id: "writer" });
    expect(state.leadId).toBeNull();
    expect(groupMemberOrder(state)).toBeNull();
    expect(groupMemberOrder(reduce(state, { type: "lead", id: "writer" }))).toEqual(["writer", "research"]);
  });

  it("keeps other members in order and does not mutate the selection", () => {
    expect(groupMemberOrder(selected)).toEqual(["writer", "research", "planner"]);
    expect(selected.picked).toEqual(["research", "writer", "planner"]);
  });

  it("clears the lead when removed, without silently promoting or restoring it", () => {
    const removed = reduce(selected, { type: "toggle", id: "writer" });
    expect(removed).toEqual({ picked: ["research", "planner"], leadId: null });
    expect(groupMemberOrder(removed)).toBeNull();
    expect(reduce(removed, { type: "toggle", id: "writer" }).leadId).toBeNull();
  });

  it("preserves the lead when other members change and tolerates repeated lead clicks", () => {
    expect(reduce(selected, { type: "toggle", id: "research" }).leadId).toBe("writer");
    expect(reduce(selected, { type: "toggle", id: "fourth" }).leadId).toBe("writer");
    expect(reduce(reduce(selected, { type: "lead", id: "writer" }), { type: "lead", id: "writer" })).toEqual(selected);
    expect(reduce(selected, { type: "lead", id: "outsider" })).toEqual(selected);
  });

  it("limits membership to six, permits removal at the limit, and prevents one-member groups", () => {
    const full = { picked: ["1", "2", "3", "4", "5", "6"], leadId: "6" };
    expect(reduce(full, { type: "toggle", id: "7" })).toEqual(full);
    expect(reduce(full, { type: "toggle", id: "1" }).picked).toHaveLength(5);
    expect(groupMemberOrder({ picked: ["writer"], leadId: "writer" })).toBeNull();
  });

  it("resets membership and lead for cancel/reopen", () => {
    expect(reduce(selected, { type: "reset" })).toEqual(emptyGroupSelection);
  });
});
