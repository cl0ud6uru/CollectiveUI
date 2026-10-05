# OpenAI native web search

OpenAI native search uses the Responses API's hosted `web_search` tool. Enable it in **Admin → Bots & tools → OpenAI native search**, then open the chat composer's compact **Tools → OpenAI native search** control and choose **Auto**. The model decides whether to search; Auto persists across messages without per-message opt-in. Direct model chats start Off. Bots opt in through **Tools → OpenAI native search**, which becomes their default; a conversation owner can switch it Off without editing the bot. In groups, Auto uses eligible bots' defaults and Off applies to every speaker.

## Availability and policy

The connection must use organization API credentials, the `openai` provider, and the default `https://api.openai.com/v1` endpoint. Saved provider connections are checked by their effective endpoint and enabled state. Azure, arbitrary compatible endpoints, ChatGPT subscriptions, and Hermes are excluded. Hermes keeps its backend tools.

The verified model list is deliberately finite: `gpt-4.1`, `gpt-4.1-mini`, `gpt-5`, `gpt-5.4`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`, `gpt-6-luna`, `gpt-6-sol`, `gpt-6.1-sol`, and `gpt-6-astra`. Unknown names and dated snapshots remain unavailable until verified. The integration does not request GPT-5's unsupported `minimal` reasoning effort.

Hosted execution happens on OpenAI's servers. CollectiveUI cannot intercept it with a local fetch rule or pause it for per-call approval. Native search is therefore unavailable when search/page access is disabled, when the selected tool requires approval, or when the local web-page allowlist is nonempty. Existing “always allow” grants cannot override that refusal. Service bots remain restricted to reviewed MCP tools.

Admins may set OpenAI's separate hosted domain filter (up to 100 domain names, including their subdomains). This is not local DNS, network, or URL enforcement. Changes to the hosted policy or model connection stop subsequent dispatches until a new request is started. Already dispatched remote work cannot be recalled by a later policy edit.

The bot editor labels SearXNG, Brave and Bing as **Web search (external)**, separately from **OpenAI native search**. Page fetch and MCP selections retain their existing behavior. Selecting native search never silently substitutes another tool. A bot may explicitly enable more than one search tool; the chat's native Off setting affects only OpenAI hosted search.

## Calls, cost and persistence

The admin limit is 1–10 hosted calls per assistant reply. `max_tool_calls` is sent on each Responses request using the remaining allowance. A database reservation spans model steps, worker retries, approval continuations, and all speakers in a group reply. A truncated or failed response retains its reservation because its unobserved calls are unknown. Starting a new user request or regenerating creates a new reply budget. Automatic provider retries are disabled while native search is attached.

Usage records count observed hosted call IDs, separately from model tokens and the ordinary tool audit log. A deterministic ledger ID prevents the same observed call being charged twice locally. Counts can be incomplete after a disconnect; they are not an OpenAI invoice. The UI and CSV expose estimated tool fees at $0.01 per observed call. Token charges are additional. Search-content tokens are not separately itemized in these SDK responses, so the application records the reported model token totals once and does not invent or add another token count. GPT-4.1 mini search-content billing uses the documented fixed 8,000-input-token block per call.

Citations use the existing streamed source chips. Source parts and tool status persist in the assistant message, including group replies, so reload and signed-in shared views retain them. Costs and limits are disclosed inside Tools before enabling and in bot settings before saving; per-answer accounting is collapsed under **Search usage**. Availability, pricing and configuration errors do not occupy a persistent composer panel. A failed settings lookup or ambiguous save marks the Tools button for attention; the explanation and reload action stay inside its dialog. Sending, editing, regeneration and approval continuations remain blocked until a reload verifies the choice, so a lost settings response cannot silently inherit paid Auto mode. Actual stream failures retain the chat's inline error and retry controls.

Apply migration `0026_openai_native_search.sql` before running the updated web app or worker. Existing chats retain a null override, direct chats stay Off, bot tool choices stay unchanged, and the admin feature defaults to disabled.

## Validation

No live credentials or paid calls are needed:

- Unit fixtures: `npx vitest run tests/unit/native-search.test.ts`
- Migrated disposable Postgres: `DATABASE_URL=… npx vitest run tests/integration/native-search.test.ts tests/integration/usage-summary.test.ts tests/integration/provider-roundtrip.test.ts`
- Browser fixtures: run the web app with local auth, a disposable localhost database named `collective_native_search_test`, and `tests/fixtures/native-search-worker.ts` with `NATIVE_SEARCH_FIXTURES=1`. The fixture worker intercepts every fetch and rejects all non-fixture destinations. Run `npx playwright test --config tests/native-search.playwright.config.ts` with the same database, encryption key, and flag. It seeds synthetic local accounts and screenshots under `/tmp`.

For a production build, use local HTTPS with matching `AUTH_URL` and `BASE_URL` (production authentication requires HTTPS). The browser configuration accepts a self-signed certificate only for `https://localhost:` when the fixture flag is set.

The browser fixture checks direct Auto/Off (including a zero-search reply), bot defaults, mobile bot labels and controls, documented Luna/Sol models, admin limits, unsupported endpoints, failed lookups/saves/searches, repeat sends, Stop, navigation, group settings, reload and shared citations. Group streaming and its shared call budget are covered by the stubbed integration suite, since group replies run in the web process rather than the fixture worker. These checks do not verify real API availability, invoice totals or live search quality.

SDK request captures verify the exact Luna/Sol model IDs, optional `auto` tool choice, hosted domain filters, source inclusion and remaining `max_tool_calls`. Database fixtures exercise two turns in both direct Auto chats and bots inheriting Auto defaults. A mixed hosted-search/function fixture checks a second model step and separate usage accounting; MCP tool selection and approval behavior are also covered. Requests retain `store: false`: the SDK does not replay raw hosted search results, while cited assistant text and function outputs remain in the next request.

## Official references

Checked 2026-10-04; additional model tool support checked 2026-10-05:

- [OpenAI web search guide](https://developers.openai.com/api/docs/guides/tools-web-search): Responses tool, citations, filtering, optional Auto behavior and model limitations.
- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create): hosted tool configuration and `max_tool_calls`. The installed OpenAI SDK maps `maxToolCalls` to this field.
- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing): $10/1,000 search calls, search-content token billing and the mini-model fixed block.
- Official model Tools tables list web search support for [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol), [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), and [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra).
