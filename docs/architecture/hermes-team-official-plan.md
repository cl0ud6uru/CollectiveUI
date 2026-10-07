# Official ChatGPT plan usage candidate

This candidate adds a distinct server transport and owner-bound account records for `openai_chatgpt_plan_usage`. Production verified model inventories remain empty. The runtime feature flag remains off by default. Existing personal Hermes/Codex connections are unchanged and are not accepted as official-plan grants.

## Contract sources

Checked on 2026-10-07 against the pinned Hermes commit `f97608f178d1ffeca59860195ab7da295f7c8e5f` and these primary sources:

- [Official model discovery and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference): discover the selected account's catalog with its own access token; send inference to the public Responses endpoint, with `store:false` and `stream:true`; successful delivery requires the terminal `response.completed` event.
- [Official preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations): omit unsupported HTTP parameters, including provider output-token limits and persistent response continuation. Local function tools use namespaces. Hosted MCP and other hosted tools are outside this adapter's supported subset.
- [Official token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference): the authorization flow supplies a verified account subject, issued client, scopes and expiry. The server ingestion boundary accepts normalized verified claims, with timestamps in milliseconds, from that authorization exchange.
- The generated public SDK schema is pinned to commit `4e152cdefe1844c2d5d78653310e9b9c0195c44e`, rather than mutable `main`: [namespace tools](https://github.com/openai/openai-python/blob/4e152cdefe1844c2d5d78653310e9b9c0195c44e/src/openai/types/responses/namespace_tool_param.py) and [function-call namespaces](https://github.com/openai/openai-python/blob/4e152cdefe1844c2d5d78653310e9b9c0195c44e/src/openai/types/responses/response_function_tool_call_param.py).

## Implemented boundaries

`official-plan.ts` exposes trusted ingestion after a verified server authorization exchange. It validates account/client/scope/expiry claims, fetches a bounded account catalog using exactly that access token, and stores a v2 encrypted access/refresh bundle. Encryption binds the immutable row, current user, client, host and account subject. Legacy unbound ciphertext is rejected. Credential/catalog changes require a new revision. No account subject, client, host, token or catalog is returned in browser model status.

This increment does not add a public OAuth start/callback controller, signature-verification implementation, refresh exchange or account-switch UI. Those are explicit authentication implementation dependencies; the trusted ingestion API is not a substitute for them. No grant, credential discovery or provider request occurs merely by opening an unavailable Team chat.

`candidate-wire-metadata.ts` separates two proofs. A global route pins the protocol, endpoint, adapter and model. A personal binding pins the current owner's selected credential and catalog revision, account identity and expiry. Two people can use one verified route with independent bindings. A retained run, handoff or approval cannot borrow another owner's proof or continue after rotation, expiry or account change.

`candidate-model.ts` is the production caller of this transport. It normalizes a bounded text Responses subset, maps flat native functions into the fixed `collective_native` namespace, and maps accepted namespace output back into the pinned native function format. Unknown namespaces, selectors, functions, hosted tools, alternate output controls and input-item overrides are rejected. The actual pinned auxiliary title client uses Chat Completions even with a Responses primary client; the adapter converts its bounded text/function/structured-output request to Responses and returns the native Chat shape after completion. The exact disabled-reasoning hint is removed. A bounded native cache-retention hint is also removed because that provider field is unsupported.

Provider input/output counters are persisted against the durable request ID. Reservations enforce local per-run allowances; they are not billable usage estimates or a hard provider spend ceiling. Calls have a 45-second deadline, bounded request/response bytes and no automatic retry, token refresh, alternate model or company-provider fallback. Unknown usage, interrupted output, unsafe tool arguments or unsupported output leaves an attributed attention receipt and fences new requests across every purpose, including fresh UUIDs. Confirmed counters survive rejected delivery. `requireHardLimits:true` rejects this `local_only` route before grant, decryption or inference because the official contract does not offer the required hard ceiling. A pinned native `max_output_tokens:256` hint is removed from the upstream request; larger or unknown limit hints are rejected.

## Private choice and readiness

Migration0044 adds the account records, immutable account-specific context binding and a private conversation model choice. Choice is owned by the conversation's current user in both Member and Admin mode. Maintainers share a working profile but do not share that preference or conversation. A save checks the expected choice and Team definition version under bot/user locks and refuses changes while that profile has active work.

`teamNativeAvailability` checks current audience/maintainer/session authority, profile state, every native purpose, exact route/transport/account proof and the protected broker's runtime capability. A disabled broker or retained `network:none` runtime stays unavailable. It does not probe connectivity. Empty catalogs or a disabled runtime flag remain connection-needed. Provisioning only marks a retained instance ready after that proof; login alone is insufficient.

## Verification and remaining gates

The synthetic HTTP/PGlite fixtures exercise the actual candidate handler/factory: two owners, every model purpose, native function conversion, auxiliary title conversion, counter attribution, account/catalog rotation, failed terminal streams, byte/time bounds, hard-limit rejection, model-choice ownership/CAS and broker network denial. The upgrade fixture preserves all0000–0043 artifacts and retained private chats, capabilities and learning receipts through0044.

Before admitting a route, complete the actual pinned native Responses function/utility/background/delegate roundtrip against the synthetic upstream and independent review of its integrated runtime. These tests establish client compatibility, not a real account's entitlement. A later explicitly authorized bounded live verification must establish the official authorization exchange, account-specific catalog, all enabled purpose/model access, expiry/reconnect behavior and actual usage counters. No live authorization or inference is part of this build. Production inventories and readiness remain closed until those gates are satisfied.
