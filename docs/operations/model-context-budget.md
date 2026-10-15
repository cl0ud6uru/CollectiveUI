# Model context budgets

Every CollectiveUI model step gets a bounded copy of conversation history. The default context window is 16,384 tokens; administrators can set **Model context window** on a model app when they know its supported size. The existing **Max output tokens** setting is reserved for generation, with a 2,048-token default when unset. If an app's output reserve is larger, the default window grows enough to leave 1,024 input tokens. The remaining window is available for system instructions, tool definitions, and input messages.

The budget runs in `prepareStep`, so it applies to the first request, every tool continuation, each bot in a group reply, and approval continuations. It also recalculates on a later user turn. Instructions and configured tools are preserved. History is dropped as complete oldest user turns; the latest user turn, including its attachments and any active tool/approval exchange, stays intact. If that protected turn does not fit, the request fails before a model request is sent. No summary or extra model call is made. A transient notice and a model-visible note report how many older turns were omitted.

The estimator is intentionally conservative, not provider-exact: it counts UTF-8 text bytes, message framing, serialized provider metadata, and a fixed allowance for inline images. Unknown or remote multimodal content fails closed. Providers tokenize text, images, and tool schemas differently, so the configured window should be the provider's documented context size; this guard reduces oversized requests but is not a tokenizer-level guarantee.

Attachment lookup remains scoped to the conversation owner's attachment records. Compaction only changes the model-bound copy; the full persisted branch remains available for later turns.
