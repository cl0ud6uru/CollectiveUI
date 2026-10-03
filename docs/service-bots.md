# Native service bots

A normal bot still uses the intersection of its selected MCP tools and the caller's direct connector access. An **admin-managed service bot** instead has an explicit, published grant to exact MCP tools. A person in its audience can use those capabilities in that bot's own direct chat without receiving direct connector access or permission to edit the bot.

## Admin setup: an IT ticket bot

1. In Admin → MCP, save the ticket connector, test it, review the captured tools, and enable it. A draft connector never appears in bot tool pickers. Direct access can be everyone, selected groups, or no ordinary users (admins only). This governs personal/caller-mode bots, independently of service grants.
2. Configure signed caller identity and mark the connector trusted only after verifying its implementation. The service tool must enforce its explicit scope arguments upstream; arbitrary SQL, unrestricted URLs, generic search languages, or a cosmetic `project` field are not suitable boundaries.
3. Create a native bot on a company model with tools. Choose **Admin-managed service bot**, set instructions, audience, and exact MCP tools, then save the draft. Only admins may edit or publish it, including after its original owner is demoted. Service bots cannot contain built-in tools, skills/knowledge, delegates, or user-added instruction/memory capabilities.
4. Review each complete tool definition in **Admin-authorized capabilities**. Classify actual effect, not an upstream `readOnlyHint`. Unknown tools default to write. Writes always ask the person for approval; an explicitly reviewed read may run automatically. Each tool requires at least one enforced exact argument constraint. For example:

   ```json
   [
     {"path":"project","source":"constant","value":"IT"},
     {"path":"requester","source":"caller.upn"}
   ]
   ```

   Constraints require declared scalar properties, may use nested object paths, and compare exact values. Missing caller identity, arrays, prototype paths, wrong types, and out-of-scope arguments fail. No arguments are silently rewritten. Input schema validation performs no coercion, defaults, property removal, or remote schema fetching. Service publication rejects unsupported schemas before use.
5. Publish the reviewed revision. Admin → MCP → **Authorized bots** lists capabilities and supports revocation; the bot editor owns the complete instructions/audience/tools/scope review. Both views are necessary: connector governance and bot capability publication answer different questions.
6. The ordinary person opens the bot's direct chat, sees its capabilities, and can file an IT ticket. They cannot edit it, reuse its connector in a personal bot, or suppress enforced approval with “Always allow”. Copies and template imports start as ordinary caller-mode bots without the source service tools, skills, routines, delegates, or grants.

## Enforcement and identity

Every MCP dispatch reloads the current caller/session, bot audience/publication, model, tool settings, selected connector/tool, grant, connector policy revision and accepted definition. It checks again after the connection handshake, before dispatch. Legacy callers retain direct-connector intersection and gain the same live checks, including current delegation edges and remembered approvals. Revocation cannot cancel a request already dispatched upstream; it prevents subsequent dispatches.

Service grants bind exact bot and connector revisions and tool-definition hashes. Approval signatures additionally bind the actor, session/groups, bot/model/configuration, conversation/run, selected tool mapping, and effective arguments (the SDK signs approval ID, tool-call ID, tool name and input). An old approval cannot authorize a new grant or different connector. Start a new request after a configuration or permission change.

Service bots only run in direct, user-owned chat conversations. Delegation, group chats and routines/background runs fail with an explicit refusal, including routine approval continuations where a caller supplied `background: false`. The invoker is always the real human, never the publishing admin. The short-lived MCP JWT retains human `sub`, groups and conversation and adds:

```json
{"service":{"id":"bot:<id>","grant":"<grant id>","revision":2,"server":"<server id>","tool":"create_ticket","run":"<run id>","call":"<tool call id>"}}
```

Configure the upstream connector to verify the signature, issuer, audience and expiry and enforce the intended identity/scope. A portal “read” label is an admin approval classification; it cannot make an upstream write implementation read-only. Use narrow upstream endpoints or separate read credentials where an upstream read-only guarantee is needed.

Publication/revocation and call decisions record actor, bot/service, grant/revision, server/tool, run/conversation/call IDs and an input hash. Raw credentials and arguments do not belong in these audit records. Credentials stay encrypted server-side; known static header values, bare auth tokens, signing secrets and recognized token patterns are redacted in results and errors before model/UI/persistence. This is credential containment, not a general data-loss-prevention guarantee against a hostile connector encoding secrets in arbitrary output. Service grants require a trusted, reviewed connector.

## Migration and review behavior

Migration `0015_native_service_bots.sql` adds opt-in service mode and grants. Every existing bot remains `caller`; existing public/group connector availability is unchanged. No service grants are inferred from ownership, existing sharing, templates, approval memories or direct connector access.

Saving a service bot invalidates publication and revokes its old grants. Connector configuration/identity changes, enabling/disabling, and accepting drift advance the connector policy revision; grant reuse requires admin review/publication. Changed or unavailable selected tools prevent execution/publication, with an explicit needs-review status. Newly discovered tools never silently enlarge a published grant. Model/instruction/audience changes invalidate the reviewed configuration. Copies/imports cannot restore a service grant.

The stronger MCP approval binding invalidates pending approvals created before this upgrade. Ask the user to start a new request; do not replay pending privileged calls as a migration step. Coordinate web/worker rollout after the migration so every executor enforces the new gate. Rollback must not run an older worker against service-mode bots: it would not understand their execution restrictions.

## Verification

`tests/unit/service-bot-policy.test.ts` covers scope/schema validation, identity and secret redaction. `tests/integration/service-bots.test.ts` requires the explicitly disposable `collective_service_bot_test` database and mocks all MCP calls. It exercises admin/user flows, copies/templates, mid-turn revocation, handshake races, approval floors and unsupported contexts. No real connector, credential or customer data is required.

For the synthetic admin/member browser flow, migrate an isolated `collective_service_bot_browser_test` database, run the local app with `AUTH_LOCAL_ENABLED=true`, matching synthetic `AUTH_SECRET`/`ENCRYPTION_KEY`, and run:

```sh
SERVICE_BOT_BROWSER=1 npx playwright test --config tests/service-bot.playwright.config.ts
```

Set `DATABASE_URL` to that disposable database and `BASE_URL` to the local app. The test seeds only synthetic users, model and connector definitions; it exercises publication, connector discovery, edit restrictions, revocation and mobile layout without contacting any MCP or model endpoint. It captures previews under `/tmp/collective-service-bot-screenshots`. Runtime execution and signed approval resume use the separate database/SDK suite with a mocked model and connector.
