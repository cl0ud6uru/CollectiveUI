# OpenAI native web search

OpenAI native search uses the Responses API's hosted `web_search` tool. Enable it in **Admin → Bots & tools → OpenAI native search**, then choose **Auto** in a chat's **OpenAI native search** control. Direct model chats start Off. Bots opt in through **Tools → OpenAI native search**, which becomes their default; a conversation owner can switch it Off without editing the bot. In groups, Auto uses eligible bots' defaults and Off applies to every speaker.

## Availability and policy

The connection must use organization API credentials, the `openai` provider, and the default `https://api.openai.com/v1` endpoint. Saved provider connections are checked by their effective endpoint and enabled state. Azure, arbitrary compatible endpoints, ChatGPT subscriptions, and Hermes are excluded. Hermes keeps its backend tools.

The initial verified model list is deliberately finite: `gpt-4.1`, `gpt-4.1-mini`, `gpt-5`, `gpt-5.4`, `gpt-5.5`, and `gpt-6-astra`. Unknown names and dated snapshots remain unavailable until verified. The integration does not request GPT-5's unsupported `minimal` reasoning effort.

Hosted execution happens on OpenAI's servers. CollectiveUI cannot intercept it with a local fetch rule or pause it for per-call approval. Native search is therefore unavailable when search/page access is disabled, when the selected tool requires approval, or when the local web-page allowlist is nonempty. Existing “always allow” grants cannot override that refusal. Service bots remain restricted to reviewed MCP tools.

Admins may set OpenAI's separate hosted domain filter (up to 100 domain names, including their subdomains). This is not local DNS, network, or URL enforcement. Changes to the hosted policy or model connection stop subsequent dispatches until a new request is started. Already dispatched remote work cannot be recalled by a later policy edit.

SearXNG, Brave, Bing, page fetch, and MCP selections retain their existing behavior. Selecting native search never silently substitutes one of them. A bot may explicitly enable more than one search tool; the chat's native Off setting affects only OpenAI hosted search.

## Calls, cost and persistence

The admin limit is 1–10 hosted calls per assistant reply. `max_tool_calls` is sent on each Responses request using the remaining allowance. A database reservation spans model steps, worker retries, approval continuations, and all speakers in a group reply. A truncated or failed response retains its reservation because its unobserved calls are unknown. Starting a new user request or regenerating creates a new reply budget. Automatic provider retries are disabled while native search is attached.

Usage records count observed hosted call IDs, separately from model tokens and the ordinary tool audit log. A deterministic ledger ID prevents the same observed call being charged twice locally. Counts can be incomplete after a disconnect; they are not an OpenAI invoice. The UI and CSV expose estimated tool fees at $0.01 per observed call. Token charges are additional. Search-content tokens are not separately itemized in these SDK responses, so the application records the reported model token totals once and does not invent or add another token count. GPT-4.1 mini search-content billing uses the documented fixed 8,000-input-token block per call.

Citations use the existing streamed source chips. Source parts and tool status persist in the assistant message, including group replies, so reload and signed-in shared views retain them. A failed settings lookup or ambiguous save blocks sending, editing, regeneration and approval continuations until a reload verifies the choice; it cannot silently inherit paid Auto mode.

Apply migration `0026_openai_native_search.sql` before running the updated web app or worker. Existing chats retain a null override, direct chats stay Off, bot tool choices stay unchanged, and the admin feature defaults to disabled.

## Validation

No live credentials or paid calls are needed:

- Unit fixtures: `npx vitest run tests/unit/native-search.test.ts`
- Migrated disposable Postgres: `DATABASE_URL=… npx vitest run tests/integration/native-search.test.ts tests/integration/usage-summary.test.ts tests/integration/provider-roundtrip.test.ts`
- Browser fixtures: run the web app with local auth, a disposable localhost database named `collective_native_search_test`, and `tests/fixtures/native-search-worker.ts` with `NATIVE_SEARCH_FIXTURES=1`. The fixture worker intercepts every fetch and rejects all non-fixture destinations. Run `npx playwright test --config tests/native-search.playwright.config.ts` with the same database, encryption key, and flag. It seeds synthetic local accounts and screenshots under `/tmp`.

The browser fixture checks direct Auto/Off, bot defaults, admin limits, unsupported endpoints, failed lookups, repeat sends, Stop, navigation, reload and shared citations. It does not verify real API availability, invoice totals or live search quality.

## Official references

Checked 2026-10-04:

- [OpenAI web search guide](https://developers.openai.com/api/docs/guides/tools-web-search): Responses tool, citations, filtering, optional Auto behavior and model limitations.
- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create): hosted tool configuration and `max_tool_calls`. The installed OpenAI SDK maps `maxToolCalls` to this field.
- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing): $10/1,000 search calls, search-content token billing and the mini-model fixed block.
