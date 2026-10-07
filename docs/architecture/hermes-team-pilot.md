# Hermes Team Bot verification gates

Team Bots remain disabled by default. Resource publication and private updates
do not establish native model or connector access. The admitted production
model-route and connector-adapter inventories are empty until their actual
pinned integrations pass verification. A successful native login alone is not
model-access evidence.

The application gate is `HERMES_TEAM_BOTS_ENABLED`; the protected Docker broker
has a separate `teamBotsEnabled` configuration value. Enabling either gate does
not make an unverified model route available. Current native iOS presents the
compatible web flow for Team Bots and prevents inference or approval fallback.

## Repeatable synthetic checks

Run `npm run typecheck`, `npm run lint` and `npm test`. With the exact pinned
Hermes source and Python fixture environment available, set `HERMES_SOURCE`
and `HERMES_PYTHON` for the native contract tests. CI installs the source at
`f97608f178d1ffeca59860195ab7da295f7c8e5f` and runs native settings,
authentication, profile, bridge, queue and networking fixtures without an
account or model call.

The browser CI job exercises the existing editor/chat, Admin mode, exact
publication review, private resource updates, recovery and shared restoration
through synthetic HTTP responses. It includes mobile widths and inaccessible
states. The PostgreSQL/PGlite and filesystem tests cover the complete teach-file
to published-resource cycle, member learning preservation, per-user visibility,
revocation and native/database crash boundaries. Bundled helper tests execute
the fixed resource engine on real temporary filesystem roots behind a synthetic
Docker API. They do not prove execution inside the actual pinned image.

## Bounded native-image verification

Before a pilot, use the exact configured image digest in an isolated cloud test
namespace and temporary owned volumes. Verify blank native profile identity,
UID 10000, helper bundle startup, the declared image volume mask, protected
journal initialization, read-only capture, apply/abort, restart fencing and
cleanup. Keep the helper's network disabled and supply no credentials. Run two
idle profiles, then two active synthetic profiles to check maintenance refusal
and the documented runtime-wide Stop behavior. Do not adopt, modify or delete an
existing personal volume during this test.

The saved environment's VFS Docker storage cannot fit the pinned image's
expanded layer prefixes in its available disk. An efficient supported storage
driver or a larger isolated cloud test environment is needed for this smoke
test. Native-image execution remains an explicit gate; successful application
Docker CI and filesystem helper tests do not substitute for it.

## Model and connector verification

Verify each intended native route and exact model against the pin, including
reply, learning, utility and native-subagent work. Test expired access and prove
that required-personal policy dispatches no company inference. Distinguish
Hermes Codex login from the official ChatGPT plan-usage integration. Record the
route's integration, model, pin and evidence before admitting it. Admin routes
must use a server gateway with attributed, bounded usage and a revocable grant;
company keys must remain outside native profiles.

Verify each native connector adapter separately. Test current actor, bot,
action, resource scope, human approval and access removal before dispatch and
approval continuation. A configured connection or existing application MCP
authorization alone does not prove native Hermes enforces it. Keep disabled
capabilities unavailable and request a personal connection only when its policy
requires the member's account.

These model/auth checks require separately authorized test access and bounded
inference. They were not performed by the synthetic build and must not silently
use live accounts, production credentials, OAuth grants or paid inference.

## One-bot pilot

After the image, model and connector gates pass and rollout is approved, use one
bot, an assigned maintainer and a second synthetic member. Teach a useful native
skill in Admin mode, review and publish only that package, then verify the member
receives it. Let the member improve another skill, learn a new skill and delete
a Team-owned skill. Publish a second Team revision and verify those choices
remain intact. Resolve one conflict, restore a reviewed older Team revision as
a new publication, remove audience access during queued/approval work, and
restart the broker. Confirm receipts, history, personal learning and existing
personal Hermes/native-harness bots remain usable. Expand only after this cycle
has verified evidence.
