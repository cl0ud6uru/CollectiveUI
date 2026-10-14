# Models, agent backends and bots

**Models** power ordinary New Chat and the native CollectiveUI bot engine. A model connection selects one provider model or deployment; the provider may advertise many models. **Agent backends** execute bots through their own runtime. Hermes supports backend-owned tools and model routing. The [Codex personal-agent preview](../codex-harness.md) uses the caller's owner-bound SIWC account and private stock app-server for direct chat with native command/file tools and thread continuation. It remains disabled by default until operator distribution, enrollment, egress and exact-image live sandbox proof are complete. Legacy manifest runtimes retain text-only behavior. **Bots** are configured assistants using one of these engines.

Admin → **Connections** separates Models from Hermes agent backend connections. The existing `/admin/apps` URL, connection IDs, API fields and database names stay compatible. Admin → **Managed Hermes** retains per-user runtime provisioning. Codex is selected in the bot editor, but its owner-bound SIWC profile and stock app-server enrollment are separate from Hermes or ordinary model connections. The optional [Mac companion](../chatgpt-companion.md) is implemented and defaults off until approved distribution, installation and HTTPS configuration. When disabled, follow the [local sign-in and protected import steps](../connections.md#peoples-own-chatgpt-plans-sign-in-with-chatgpt). The original Models/Agent backends terminology change required no schema migration; the Codex foundation uses `0053_codex_harness`, personal runtimes add 0054/0055, and the current complete journal runs through `0057_chatgpt_companion`. Apply all migrations with matching web and worker code.

## Existing Hermes conversations

All manual and managed Hermes connections are bot-only. They do not appear in New Chat or default model selections. Direct chat POSTs, regeneration, approval continuation, command requests and shared-chat continuation are rejected before creating a new run. Workers recheck the execution target, and model resolution also requires a bot for Hermes.

Existing direct Hermes messages remain readable. Open **Bots** and choose or create the intended Hermes bot to start a new conversation. The old session is never reassigned to another bot/profile. Existing history and stop/cancellation remain available; old direct-chat approvals cannot start another turn.

A saved default pointing to Hermes, a disabled connection or an inaccessible model produces an actionable selection state. It does not silently choose another provider. An explicitly configured but ineligible utility connection disables that background model work until an admin selects an eligible company model. Copying a bot or template requires its original accessible connection, including when deletion cleared the source reference.

## Verification

`tests/integration/model-routing.test.ts` covers both Hermes modes, direct API entry points, history, defaults, utility writes, shared continuation and duplicate/template routing. Existing Hermes command fixtures now use bots.

For local browser coverage, use a disposable, migrated database named `collective_models_test`, local auth enabled, and the app at `http://localhost:3120`. Run the checked-in mock LLM at port 4020 and the worker against that same database. Use synthetic auth/encryption secrets, not deployment credentials.

```sh
PORT=4020 npm run mock-llm
# In separate terminals with the disposable environment configured:
npm run dev -- --port 3120
npm run worker
MODELS_BROWSER_TEST=1 PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium \
  npx playwright test --config tests/models-routing.playwright.config.ts
```

The browser suite seeds synthetic local admin/member accounts and tests the model picker, admin sections, engine/model/backend selectors and saved updates, Hermes `/help`, blocked direct requests and retries, read-only history approvals, default/empty states, keyboard use and mobile width. It refuses to seed any other database. Screenshots go to `/tmp/collective-models-screenshots`.

No paid model or live Hermes calls are required. Managed runtime authentication/profile ownership is covered separately by the existing gated provisioning suite using isolated HTTP mocks and its required disposable database.
