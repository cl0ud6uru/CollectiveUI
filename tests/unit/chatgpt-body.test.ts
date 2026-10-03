import { describe, expect, it } from "vitest";
import { FALLBACK_INSTRUCTIONS, rewriteCodexRequestBody } from "@/lib/llm/chatgpt/body";

describe("Codex backend request body", () => {
  it("keeps only fields Codex sends, forces store:false/stream:true and fills instructions", () => {
    const out = rewriteCodexRequestBody({
      model: "gpt-x",
      input: [],
      max_output_tokens: 8192,
      temperature: 0.2,
      top_p: 1,
      metadata: { a: 1 },
      user: "u",
      service_tier: "priority",
      store: true,
      previous_response_id: "resp_1",
      prompt_cache_key: "conv-1",
      reasoning: { effort: "high", summary: "auto" },
      text: { format: { type: "json_object" } },
    });
    expect(out).toEqual({
      model: "gpt-x",
      input: [],
      store: false,
      stream: true,
      instructions: FALLBACK_INSTRUCTIONS,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "conv-1",
      reasoning: { effort: "high", summary: "auto" },
      text: { format: { type: "json_object" } },
    });
  });

  it("strips item ids and references, types string content and uses developer instead of system", () => {
    const out = rewriteCodexRequestBody({
      instructions: "Be brief.",
      include: ["message.output_text.logprobs"],
      input: [
        { role: "system", content: "extra rules" },
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: "hello", id: "msg_1" },
        { type: "item_reference", id: "rs_1" },
        { type: "reasoning", id: "rs_2", encrypted_content: "blob", summary: [] },
        { type: "reasoning", id: "rs_3", summary: [] },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "t", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
      ],
    });
    expect(out.instructions).toBe("Be brief.");
    expect(out.include).toEqual(["message.output_text.logprobs", "reasoning.encrypted_content"]);
    expect(out.input).toEqual([
      { role: "developer", content: [{ type: "input_text", text: "extra rules" }] },
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      { type: "reasoning", encrypted_content: "blob", summary: [] },
      { type: "function_call", call_id: "call_1", name: "t", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ]);
  });

  it("defaults function tools to strict:false and drops empty tool settings", () => {
    const withTools = rewriteCodexRequestBody({
      tools: [
        { type: "function", name: "a", parameters: {} },
        { type: "function", name: "b", parameters: {}, strict: true },
        { type: "web_search" },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
    });
    expect(withTools.tools).toEqual([
      { type: "function", name: "a", parameters: {}, strict: false },
      { type: "function", name: "b", parameters: {}, strict: true },
      { type: "web_search" },
    ]);
    const without = rewriteCodexRequestBody({ tools: [], tool_choice: "auto", parallel_tool_calls: false });
    expect(without).not.toHaveProperty("tools");
    expect(without).not.toHaveProperty("tool_choice");
    expect(without).not.toHaveProperty("parallel_tool_calls");
  });
});
