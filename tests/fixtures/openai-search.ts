/** Synthetic Responses SSE. This fixture never performs network requests. */
export function searchResponse({ calls = 1, interrupted = false, failure = false, id = "fixture", model = "gpt-4.1" } = {}) {
  const events: unknown[] = [];
  const ev = (type: string, rest: object) => events.push({ type, ...rest });
  ev("response.created", { response: { id: `resp_${id}`, created_at: 1, model, status: "in_progress" } });
  for (let i = 0; i < calls; i++) {
    const item = { type: "web_search_call", id: `ws_${id}_${i}`, status: "in_progress" };
    ev("response.output_item.added", { output_index: i, item });
    if (!interrupted && !failure) ev("response.output_item.done", { output_index: i, item: { ...item, status: "completed", action: { type: "search", query: "fixture weather", sources: [{ type: "url", url: "https://example.com/weather" }] } } });
  }
  if (failure) {
    ev("response.failed", { sequence_number: events.length, response: { id: `resp_${id}`, error: { code: "server_error", message: "Fixture search failed. Try again." } } });
  } else if (!interrupted) {
    const item = { type: "message", id: `msg_${id}`, role: "assistant", status: "in_progress", content: [] };
    const answer = calls ? "Fixture weather is sunny. [Source](https://example.com/weather)" : "Fixture answer without web search.";
    ev("response.output_item.added", { output_index: calls, item });
    ev("response.content_part.added", { item_id: item.id, output_index: calls, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    ev("response.output_text.delta", { item_id: item.id, output_index: calls, content_index: 0, delta: answer });
    if (calls) ev("response.output_text.annotation.added", { item_id: item.id, output_index: calls, content_index: 0, annotation_index: 0, annotation: { type: "url_citation", url: "https://example.com/weather", title: "Fixture weather", start_index: 0, end_index: 24 } });
    ev("response.output_item.done", { output_index: calls, item: { ...item, status: "completed", content: [{ type: "output_text", text: answer, annotations: [] }] } });
    ev("response.completed", { response: { id: `resp_${id}`, created_at: 1, model, status: "completed", usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  }
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}
