# Hermes Team Bot model and connector boundaries

The Team Bot policy layer ships with **no verified model routes and no verified native tool adapters**. An authenticated account, an existing personal Hermes configuration, or an app MCP grant cannot enable a Team Bot run. The initial runtime admission therefore remains `connection_needed`. These modules provide executable admission contracts and synthetic regression fixtures; they do not install an inference gateway or connector bridge.

## Model admission

`src/lib/hermes-team/model-policy.ts` defines the three bot policies:

- `admin_provided`: the configured admin route only.
- `admin_default_personal_allowed`: the admin route by default, or a member's explicit personal choice.
- `personal_required`: the current member's personal route for replies, native learning, utilities and subagents.

A personal choice has no admin fallback. A missing, revoked or expired personal connection pauses work with connection/reconnect guidance. Sign-in identity is separate from model access.

Every enabled route must have server-owned verification evidence matching the exact Hermes commit, adapter, model and integration. All four work categories must be tested before admitting any native run, because Hermes can launch helper work itself. Evidence and personal connections expire independently. `hermes_native_codex` and `openai_chatgpt_plan_usage` are distinct integration identifiers; evidence or connection state for one does not authorize the other. The production route list remains empty until bounded verification demonstrates a supported route.

`createTeamModelGateway` derives the human from the current authenticated context, loads current bot/audience policy, reserves attributed usage, then rechecks identity, policy, audience and expiry immediately before dispatch. Attribution includes the human, bot, run, policy version, route, adapter, integration, model, billing source, purpose and personal connection identifier. No credential, endpoint or filesystem path belongs in the bot policy or attribution.

The injectable gateway adapter must resolve credentials only on the server, enforce the fixed route/model without environment fallback, atomically revalidate authority at execution, own idempotent execution receipts and settle reserved usage. A pre-dispatch rejection releases a reservation. Once dispatch begins, the adapter retains responsibility for conservative settlement: an unsuccessful response does not prove that no billable work happened. Gateway revocation must also cancel or block affected active and queued work. No adapter with these live guarantees is registered by this increment.

## Native tool admission

`src/lib/hermes-team/tool-policy.ts` defines one fixed configuration per capability: `approved_team_connection`, `member_connection`, or `disabled`. Enabled capabilities require an exact connection identifier, verified native adapter, action and bounded resource identifiers. Writes always require human approval. Team connections are bound to the bot; member connections are bound to the current person.

The adapter validates the actual native arguments and derives their action/resource scope. A caller cannot expand scope with a claimed resource or action. Canonical input rejects inherited objects, accessors, unsafe keys, sparse/accessor arrays, excessive depth and oversized data. Review binds the canonical argument hash to the human, bot, run, capability, policy version and connection version.

`createTeamConnectorService` checks current authorization before looking up an approval and again immediately before dispatch. Audience removal, account disablement, policy edits, credential rotation, expiry or changed arguments invalidate continuation. Ordinary app MCP authorization does not authorize native Hermes tools; an explicit tested bridge is required. Unsupported tools remain disabled.

The connector service alone holds company credentials. Its dispatch adapter must atomically consume the approved continuation, recheck current authority and enforce durable idempotent execution. Secret redaction, company connection storage, adapter-specific argument validation, and cancellation are responsibilities of the supported server connector implementation. This increment does not place secrets in profiles, connect any account or execute a native tool.

## Saved policy and revocation integration

The existing Team configuration API saves the validated model and tool policies under the bot lock and expected definition version. Older editors may omit `toolPolicy`; that omission retains the saved configuration. Policies contain only identifiers and scopes. No verified adapter inventory is currently available, so the editor must present an unavailable state rather than offering arbitrary native routes or connection identifiers.

Changing a definition invalidates retained grants. Editing the bot audience, removing group membership or mappings, deleting a portal group, disabling a bot or changing an account's access queues server-derived revocation operations in the same database transaction. Directory sign-in refreshes, password resets/changes and Account Security changes also invalidate the affected member or maintainer's grants. Nested directory refreshes queue within the caller's authentication transaction; its post-commit hook performs cleanup. Queued replies and waiting approvals receive cancellation requests before commit. Group/account writes acquire the existing Team bot locks in order before changing permissions. The broker cleanup runs after commit, records any runtime-wide interruption and retains all profile and conversation data.

Broker failures leave durable `needs_attention` receipts. Fresh authorization fences the affected person/mode until cleanup succeeds; reopening authorized work retries the same receipts. Malformed cleanup authority fences the bot instead of inferring a target. Cleanup workers lock and re-read each receipt, and the broker deduplicates its scoped receipt across concurrent requests and restarts. An old retry cannot stop a newly reopened grant. Retained profile ownership cannot bypass the current audience. These receipts are cleanup records and do not replace the gateway's atomic dispatch and usage settlement requirements.

`recordTeamRunAdmission` derives the actor, bot, profile, conversation and policy version from stored records, rejects stale/cancelled work, and records one stable attribution after verified policy admission. Bounded, strictly typed admission details retain the exact route, adapter, integration, model, billing source, connection/grant identifiers, verification evidence and usage receipt for each admitted purpose. Adding a purpose preserves the existing route/evidence; changing an existing purpose's usage receipt is rejected. Historical rows retain nullable evidence without fabricated verification. The synthetic gateway fixture proves that attributed usage intent commits before dispatch. The production route inventory remains empty, so normal calls reject every inference purpose and never record a false successful admission. This helper is a gateway integration boundary; Team native execution remains independently blocked and no live gateway is installed.

## Verification and enablement

The unit fixtures use synthetic people, connections, models, evidence and approvals at the currently pinned Hermes commit. They cover deny defaults, exact evidence mismatch, every model work category, no personal-to-company fallback, expiry, usage-limit failure, queued revocation, forged tool scope, approval binding and continuation revocation. They make no paid model calls and no OAuth grants.

A future bounded live verification must test the exact integration/model and all native inference categories, demonstrate that personal-required work makes no admin-provider calls, and verify gateway expiry/limits/revocation and explicit native connector authorization. Pilot enablement remains blocked until that verification and the runtime lifecycle checks succeed.
