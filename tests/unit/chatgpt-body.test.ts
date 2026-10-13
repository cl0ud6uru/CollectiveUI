import { describe, expect, it } from "vitest";
import { FALLBACK_INSTRUCTIONS, rewriteChatGPTRequestBody } from "@/lib/llm/chatgpt/body";

describe("public Responses request shaping for SIWC", () => {
  it("disables server storage, response chaining, and fields unsupported by SIWC", () => {
    const out = rewriteChatGPTRequestBody({
      model: "gpt-x", input: [], instructions: "Be useful", store: true, stream: false,
      previous_response_id: "resp_private", max_output_tokens: 2048, temperature: 0.2, top_p: 1,
      metadata: { secret: "drop" }, user: "drop", include: ["reasoning.encrypted_content"],
    });
    expect(out).toEqual({
      model: "gpt-x", input: [], instructions: "Be useful", store: false, stream: true,
    });
    for (const field of ["previous_response_id", "max_output_tokens", "temperature", "top_p"]) expect(out).not.toHaveProperty(field);
  });

  it("replays portable history and drops private references and sealed reasoning", () => {
    const out = rewriteChatGPTRequestBody({
      input: [
        { role: "system", content: "extra rules", id: "msg_sys" },
        { role: "user", content: "hi", id: "msg_user" },
        { role: "assistant", content: "hello", id: "msg_assistant" },
        { type: "item_reference", id: "rs_private" },
        { type: "reasoning", encrypted_content: "private blob" },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "math.add", namespace: "collectiveui", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "2" },
      ],
    });
    expect(out.instructions).toBe(FALLBACK_INSTRUCTIONS);
    expect(out.input).toEqual([
      { role: "developer", content: [{ type: "input_text", text: "extra rules" }] },
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      { type: "function_call", call_id: "call_1", name: "math.add", namespace: "collectiveui", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "2" },
    ]);
  });

  it("retains local function tools but filters hosted tools", () => {
    const out = rewriteChatGPTRequestBody({
      tools: [
        { type: "function", name: "math.add", parameters: { type: "object" } },
        { type: "web_search_preview" },
        { type: "computer" },
      ], tool_choice: "auto", parallel_tool_calls: true,
    });
    expect(out.tools).toEqual([{
        type: "namespace", name: "collectiveui", description: "CollectiveUI local tools",
        tools: [{ type: "function", name: "math.add", parameters: { type: "object" } }],
      }]);
    const without = rewriteChatGPTRequestBody({ tools: [{ type: "web_search" }], tool_choice: "auto", parallel_tool_calls: false });
    expect(without).not.toHaveProperty("tools");
    expect(without).not.toHaveProperty("tool_choice");
    expect(without).not.toHaveProperty("parallel_tool_calls");
  });
});
