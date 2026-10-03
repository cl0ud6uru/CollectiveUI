# Models, agent backends and bots

**Models** power ordinary New Chat and the native CollectiveUI bot engine. A model connection selects one provider model or deployment; the provider may advertise many models. **Agent backends** execute bots with their own tools and model routing. Hermes is the only implemented external agent backend. **Bots** are configured assistants using either engine.

Admin → **Connections** separates Models from Agent backends. The existing `/admin/apps` URL, connection IDs, API fields and database names stay compatible. Admin → **Managed Hermes** retains per-user runtime provisioning. This change needs no schema migration.

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
