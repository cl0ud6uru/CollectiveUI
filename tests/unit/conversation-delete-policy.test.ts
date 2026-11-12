import { describe, expect, it } from "vitest";
import { conversationDeleteFeedback, rethrowConversationDeleteError } from "@/lib/chat/delete-policy";

describe("retained Team deletion feedback", () => {
  it.each(["hermes_team_candidate_contexts_run_id_agent_runs_id_fk", "hermes_team_learning_handoffs_child_run_id_agent_runs_id_fk"])("maps only the known %s retention fence, including a wrapped database error", async constraint => {
    const cause = { code: "23503", constraint };
    expect(() => rethrowConversationDeleteError({ cause })).toThrow("Archive");
    expect(await conversationDeleteFeedback(async () => { rethrowConversationDeleteError({ cause }); })).toEqual({ ok: false, error: expect.stringContaining("Archive") });
  });
  it("does not redact unrelated failures into a misleading retention result", async () => {
    const error = { code: "23503", constraint: "unrelated_constraint" };
    await expect(conversationDeleteFeedback(async () => { rethrowConversationDeleteError(error); })).rejects.toBe(error);
    expect(await conversationDeleteFeedback(async () => {})).toEqual({ ok: true });
  });
});
