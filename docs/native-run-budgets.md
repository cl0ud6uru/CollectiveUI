# Native request-tree model budgets

`NATIVE_RUN_BUDGET` is an optional server/worker environment JSON policy. It is **off by default** (unset, empty, or exactly `{"enabled":false}`). No live policy is enabled by this change. Apply migration `0060_native_run_budgets` on deployment before running this code, and configure every web and worker process consistently. Invalid nonempty configuration refuses admission.

An enabled policy creates one durable budget for a native assistant root message, owned by its requesting user. The same root identity follows synchronous/asynchronous delegates, child continuations, approval resumptions, group speakers, title generation, decision classifiers, memory-query/remember embeddings and knowledge-query embeddings. Separate user turns get separate budgets. Scheduled extraction, learning review and ingestion jobs that do not belong to a running request tree remain outside this policy. Remote/local Hermes, ChatGPT-plan and Codex execution do not implement this native contract; a capped native tree cannot silently route to them.

Example shape, with **synthetic rates that must be replaced and reviewed before use**:

```json
{
  "enabled": true,
  "maxTokens": 200000,
  "maxCostMicros": 1000000,
  "maxInputTokensPerCall": 50000,
  "maxOutputTokensPerCall": 4096,
  "routes": [
    {
      "provider": "openai",
      "model": "YOUR_EXACT_MODEL_ID",
      "inputContract": "conservative-text-v1",
      "inputMicrosPerMillion": 1000000,
      "outputMicrosPerMillion": 2000000
    }
  ]
}
```

At least one aggregate cap is required; set the unused cap to `null`. Cost values are integer USD microdollars; rates are microdollars per million tokens, rounded upward for each attempt. An embedding route must use zero output rate. A monetary cap requires explicit input and output rates for every exact provider/model, including utility, embedding and fixed `gpt-6-luna` decision calls. Unknown models/prices fail before dispatch, without trying another account or provider. Token-only policies can omit prices; that omission is not a monetary estimate.

`conservative-text-v1` is an explicit operator approval of the native text adapter, provider framing and configured worst-case rates. Local admission serializes the AI SDK's final provider-bound parameters after schema conversion and defaults, including instructions, messages, tool descriptions/JSON schemas, tool choice, output limits and provider options. Direct decisions serialize their actual request body. The envelope reserves twice the UTF-8 serialized byte count, 128 units per JSON node and 4096 framing units. It is a deliberately conservative local admission estimate, not a tokenizer or a promise about provider invoices. SDK/provider updates require re-review of this contract. An input exceeding the per-call ceiling fails before dispatch. Native model output is capped to the policy's per-call output limit; Decisions also enforces its separately configured fixed-model context/output limits.

Opaque provider references or encrypted reasoning, non-JSON inputs, multimodal/file/image/audio/video payloads, provider-executed/hosted tools and native search fees have no supported envelope and fail closed before dispatch. This includes modalities advertised by a model: enabling a run budget does not certify their billing bounds. Text extracted from attachments is counted when it reaches the model parameters. No credentials, raw prompt or serialized tool body is stored in budget tables.

## Reservation and settlement

A PostgreSQL transaction locks the root budget row and checks **reported usage plus every outstanding reservation** against both caps before creating an attempt receipt. Concurrent delegates/retries cannot spend the same remaining capacity. The attempt is marked dispatched durably before entering the provider; every AI SDK retry and embedding batch gets its own receipt. Direct Decisions calls make one attempt with no retry.

Complete nonnegative provider input/output counters settle once at the root's frozen rates and release unused reservation capacity. Reported overage is charged in full and closes further admission. Unknown/missing counters, timeouts, cancellation, interrupted streams and ambiguous transport errors retain the full reservation; partial known counters remain visible on the receipt/usage ledger. For example, a Decisions response with only `input_tokens` keeps its reservation because output is unreported. Cancellation is not proof that the provider performed no billable work. A proven pre-dispatch cancellation can release its reservation; process death after admission conservatively leaves it held.

`native_run_budgets` and `native_run_budget_attempts` expose usage, outstanding capacity, frozen policy/rates, attempt state and run/model identity for operations. Receipt settlement/release is idempotent. They are admission records, not provider invoice reconciliation. There is no automatic expiry/refund of uncertain receipts or administrative reset API. Numeric reports outside the supported cost envelope retain capacity and close further admission rather than rounding down.

Enabled configuration changes apply to newly created roots. Existing root rows remain authoritative with their original rates and caps even if another process has the feature unset or configuration is later disabled. Disabling configuration only stops creation of new capped roots; it cannot refund or bypass existing roots. Keep deployment configuration consistent and retain receipt state for inspection.

## Validation and limits

Focused tests use migrated PGlite fixtures for reservation races, settlement/refund, retries, unknown prices, ownership and independent roots. Actual AI SDK fixtures cover Zod `.describe()` schema expansion, full instructions, output caps, failed retry receipts, interrupted streams and embedding accounting. Direct decision fixtures cover complete/partial usage, timeout, no retry and shared exhaustion. Harness tests preserve root identity through continuations and delegation, and all three classifier helpers forward the selected API attribution and root scope.

PGlite's single-connection fixture proves transactional final state; it does not simulate real PostgreSQL cross-process lock scheduling. Production admission uses PostgreSQL `SELECT ... FOR UPDATE` and durable receipt transitions. No paid-provider, live-policy, deployment or browser test is required for this disabled-default implementation. Hidden provider-side retries, tokenization changes, cache pricing adjustments, currency/tax/discount changes and other invoice adjustments are outside the local contract. Review provider billing separately.
