# Default coordinator

An installation admin can enable a native coordinator in **Admin → Settings → Default coordinator**:

- **Off** preserves ordinary entry and every existing bot and chat.
- **Choose an existing bot** selects an enabled native caller bot. Its name, avatar, prompt, tools, audience and model stay intact. An admin can select Lloyd GPT or any other eligible native bot.
- **Create The Queen starter** creates one organization-visible caller bot named **The Queen**, with the editable **Coordinator** role enabled. It has a shipped purple hexagon avatar and an editable planning/synthesis personality. The name is optional branding, not a special system identity. Model selection starts at **Configure later**; no paid model, tool or connector is selected automatically. Use the ordinary bot editor to change its identity, personality, avatar, model or audience.

Starter creation is serialized and records a durable receipt in installation settings. Repeated clicks and concurrent retries return the same bot without resetting edits, re-enabling a disabled installation choice, or changing its model. Deleting the starter retains the receipt; select an existing bot instead of silently recreating Queen. Selecting an existing bot never marks specialists eligible on the admin's behalf.

The `/` entry honors an explicit personal bot/model start choice first. People following the organization default open their own canonical home for an accessible, configured coordinator; when the coordinator is off, the branding start target applies, then the first available model if no target is configured. An unavailable configured winner does not fall through. Personal/branding bot starts create fresh ordinary chats; explicit `/?bot=` entry still opens that bot’s canonical home. Existing homes and history remain intact; `/new` uses the existing rollover path. Direct specialist chats and focused side chats are unchanged. The coordinator is first among unpinned sidebar bots, with a default-coordinator label; this does not rewrite pin/hide preferences. A hidden coordinator is not reopened automatically. A missing, disabled, out-of-audience, hidden, or otherwise unavailable default produces a generic chooser with **no fallback model selected**. A visible coordinator without an available model displays a setup message. Admin oversight does not bypass audience filtering for this entry. Explicit model links and `/?chat=model` retain ordinary model chat.

## Editable coordinator role and new-bot delegators

**Bot editor → Configure → Coordinator** controls whether a native caller bot is suggested as a delegator when its editors create new bots. It is separate from the installation's start bot and from **Allow coordinator delegation**, which opts a specialist into automatic discovery. Newly created The Queen starters have this role on; existing bots, names, pet choices and teams are preserved. Changing the role affects future suggestions only.

**New bot → Configure → Delegators** highlights eligible coordinators initially. Users can deselect any or all of them before saving. Leaving without creating has no effect. The submitted selection creates ordinary incoming Team links in the same transaction as the new bot; an unavailable or unauthorized selection rolls back creation. Existing explicit selections are never repopulated on save. To change a saved link, edit the coordinator's **Team**. The existing limit of 20 bots per Team also applies to these incoming links.

A suggested delegator must be enabled, native, caller-mode, editable by the creator, visible in that person's ordinary audience and configured with a usable tool-capable model. Owners can use their personal coordinators; admins can use shared coordinators within their audience. Visibility alone never permits a non-owner to edit a shared coordinator's Team, and admin oversight does not expose another person's private coordinator in these defaults. Each actual dispatch still applies existing caller, bot, model and tool authorization. Selecting a delegator does not share a private specialist, opt it into automatic discovery or grant connector access. Service and Hermes bots cannot use this role or the new incoming-link defaults.

Migration `0023_coordinator_roles` adds `bots.is_coordinator NOT NULL DEFAULT false`. It changes no existing bot settings or relationships, including existing starters. Enable the role explicitly on an existing starter if desired.

## Specialist access and execution

In a native caller bot's editor, its owner/admin can enable **Allow coordinator delegation**. This permits automatic discovery only for callers already allowed to use that bot and its native model. Existing bots default to opted out. Private ownership and group membership still apply; an admin's oversight access is not an automatic discovery grant. Opt-in is not a connector grant and is not copied through templates or duplication. Regular manual team links continue independently of this flag and of coordinator on/off.

The offered `ask_*` tools create a private linked task under the receiving bot. Sync remains the default; a durable native turn can choose async to queue the specialist, release the parent worker slot and continue the original reply after committed results return. Activity reflects actual run state. Task tool names include a bot ID suffix to disambiguate equal names. Depth is capped at two, with eight durable admissions per root reply, four running tasks per root and sixteen open async tasks per human. Cycles are rejected. The root deadline is shared and each run's step allowance persists across continuations. These limits do not reset on approval/task continuation and are not an installation spending cap. See [native async tasks](native-async-tasks.md).

Automatic delegation is limited to a requesting human's own direct chat: no group, routine, archived, or foreign conversation. Automatic discovery is only at the root coordinator; nested specialist handoffs require manual links. Service bots and managed Hermes bots cannot participate in delegation; automatic paths require native models throughout. Ordinary manually connected Hermes delegation retains its existing synchronous behavior outside automatic paths. No service-bot grant is reused or enlarged.

Discovery and each dispatch re-read the principal and session version, selected default, opt-in, bot/model lifecycle and audience. MCP invocation revalidates each delegation edge along with the existing connector authority checks. Nested built-in tools on automatic paths compare the permissions used to build their toolset with current principal/groups, bot, model, configured tools, remembered grants, tool settings and workspace policy. Revocation denies the next dispatch. Already completed or in-flight calls cannot be recalled. Actions needing fresh human approval cannot pause in a synchronous specialist; the user is directed to its own direct chat. Specialist memories/files use the requesting user's context, never the bot owner's account or home.

## Schema and persisted source authorization

`0018_default_coordinator.sql` adds only `bots.coordinator_eligible NOT NULL DEFAULT false`; the coordinator selection/creation receipt uses the existing `settings` table with key `coordinator`:

```ts
{ enabled: boolean; defaultBotId: string | null; starterBotId: string | null }
```

Absent settings mean off, on both fresh installs and upgrades. Migration does not create Queen, choose a model, change existing identities or audiences, opt any bot in, adopt historical chats, or alter provider/MCP/security settings. The main-to-coordinator migration is tested both initially and on replay.

Published `0018_default_coordinator` remains unchanged at journal index 18 and timestamp `1790985940212`. Regenerated `0019_delegated_tasks` and `0020_native_async_tasks` follow it with increasing timestamps and snapshot ancestry. Fresh installs, upgrades from main0017, and upgrades from deployed coordinator0018 preserve existing identities, homes/history, tools/grants, sidebar settings and pets. Migration does not overwrite any existing bot boundaries; the updated truthful sync/async guidance applies only to newly created starters.

`src/lib/coordinator/delegation.ts` exports the shared policy:

```ts
type DelegationMode = "manual" | "coordinator";
type DelegationEdge = { from: string; to: string; mode?: DelegationMode };
discoverDelegates(ctx): Promise<{ bot: Bot; mode: DelegationMode }[]>;
authorizeDelegation(ctx, targetId, mode): Promise<{ principal: Principal; bot: Bot; app: AiApp }>;
assertDelegationPath(ctx): Promise<Principal>;
```

An absent edge mode means legacy manual authorization and requires its stored `bot_delegates` link. Automatic edges require current coordinator policy. `AgentCtx.delegationPath` carries the persisted mode; a database count enforces the root budget across segments.

The shared persisted-source adapter resolves human ownership/session, original conversation/run, root task and mode/path from stored task provenance. Admission, worker execution, each model/tool dispatch and undelivered result revalidate it. A child's own conversation, identity and unattended status remain intact. Automatic edges are restricted to the first edge from the eligible direct source; descendants require manual links. Shared MCP checks use this same adapter. Hermes async remains unsupported.

## Validation

Use synthetic fixtures and disposable loopback Postgres databases only. No live provider or connector is needed. Run standard `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`.

- `tests/integration/coordinator.test.ts`: migrated `collective_coordinator_test`; admin/default/eligibility/revocation/isolation/source/cycle/budget tests and actual durable executor with a local mock model.
- `tests/integration/coordinator-upgrade.test.ts`: `COORDINATOR_UPGRADE_TEST=1`, empty `collective_coordinator_upgrade_test`; checks contiguous filenames/journal indices, snapshot ancestry, fresh installs, main0017/coordinator0018 fixture preservation and replay.
- Existing bot-home, roster, model-routing and review-regression suites; existing service-bot suite uses its separate `collective_service_bot_test` database.
- `tests/coordinator.playwright.config.ts`: `COORDINATOR_BROWSER=1`, migrated `collective_coordinator_browser_test`, local-only authentication, synthetic secrets and app port 3066. Covers keyboard setup, no-model starter, rename/model configuration, default selection/off, per-user homes, specialist entry, `/new`, mobile layout/navigation and no hidden/default fallback leakage. Model/connector URLs are inert fixtures; the browser suite sends no provider requests.

Coordinator-role validation extends the coordinator integration suite with role/default editing, personal/shared eligibility, rejected forged and revoked selections, atomic incoming links, explicit empty selections, Team capacity, rename/retry preservation and caller isolation. The migration suite covers the public 0022 baseline as well as fresh, 0017 and 0018 upgrades and replay. The browser suite also checks canceled creation, repeated selection, tab changes and desktop/mobile personal defaults. For local HTTP development, use `AUTH_URL=http://localhost:3066` and `BASE_URL=http://localhost:3066` with the disposable browser database and synthetic secrets.

Actual UI evidence: [desktop delegators](../testing/evidence/coordinator-role/desktop.png), [mobile personal coordinator](../testing/evidence/coordinator-role/mobile.png). These screenshots show synthetic local accounts and the existing avatar.
