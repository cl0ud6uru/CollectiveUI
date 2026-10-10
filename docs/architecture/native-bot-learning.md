# Native bot learning

Native caller bots learn reusable procedures after completed direct-chat runs. This is a harness feature: Action1 is an acceptance example, not a special integration. Hermes providers retain their own learning system. Admin-managed service bots retain their publication boundary and do not acquire mutable learned instructions.

## Behavior

The run completion hook creates a durable review receipt and enqueues `learning.review`. The worker reviews successful tool-using turns and explicit preference/correction messages. It skips failed, cancelled, interrupted, suspended, delegated, and scheduled runs. A review can return no lessons or up to three lessons.

Reviews use the configured company utility model, or the conversation model when eligible for organization-funded background work. Personal ChatGPT plans are never used for this work. With no eligible model, the review is skipped; later turns can learn after a utility model is configured. Calls use the existing `memory` usage purpose and are attributed to the source run and assistant message. The reviewer receives bounded text and completed tool results, has no execution tools, and has a 60-second timeout.

This first implementation reviews eligible completed turns instead of Hermes's periodic ten-iteration skill trigger. It lets short recurring MCP workflows learn immediately. It does not interrupt the foreground reply or inject synthetic user messages.

## Two scopes

- **User:** personal preferences and procedures, scoped to the acting user and bot. The bot owner cannot see another user's private lessons.
- **Bot:** general procedures verified by successful tool calls, visible to the bot's current audience. Concrete inventory/user identifiers and source-chat references are excluded from the client projection. Known identity and inventory values are checked before a shared write.

The model separates mixed lessons into personal adaptations and general methods. Preferences are forced to user scope. A shared procedure without valid successful-call references is downgraded to user scope. Failed, denied, preliminary, pending, and delegation receipt outputs do not establish verification. An assistant's completion claim alone is not evidence.

Organizational policies are pending proposals. The owner or an administrator must approve them before they load. Classification and generalization are model judgments, supported by deterministic scope/evidence checks; they are not a guarantee that every generated procedure is correct. Shared technical procedures activate automatically. Neither scope changes tool permissions or overrides the bot's instructions, boundaries or approvals.

For the Action1 acceptance request, “Check if KY workstations need critical updates installed,” the shared lesson should describe resolving an unambiguous workstation group, querying missing critical updates, checking pagination and reporting results. Individual report formatting stays private. A check request does not authorize installation; the reviewer cannot invoke MCP tools.

## Storage and retrieval

Migration `0036_native_bot_learning` adds `bot_learnings`, `bot_learning_revisions`, and `bot_learning_reviews`. Manually authored skills are unchanged and are never rewritten by the reviewer. Learned topics are unique within a bot/shared or bot/user scope. Private and shared lessons can coexist for the same topic.

Active procedures and approved policies are offered through the existing `use_skill` loader, including for bots without a manually configured Skills group. Slugs use readable scope/topic names (`learned-shared-critical-update-check` or `learned-personal-critical-update-check`) and remain stable through title edits. The previous `learned-<id>` names remain aliases for persisted routine prompts, slash commands and tool calls within the authorized skill catalog. Private preferences stay in the versioned learning store but load through `selectMemories`, not `use_skill`. They appear under Memory and never enter another user’s context. Disabling Skills organization-wide also disables learned procedure generation and retrieval. The loader returns the skill ID and revision alongside its instructions, so existing tool-call audit records can identify which revision was used.

Each change records a full revision, including its kind, and protected source provenance. A source run commits once. Background updates require the version observed before model generation; stale updates are discarded. Archived topics cannot be resurrected automatically. A pending policy stays pending, and changes to an approved policy require renewed approval.

The bot profile’s **Skills** tab combines manually authored and learned procedures. Cards identify their source (`Manual` or `Learned`) and audience (`Shared` or `Personal`). Learned personal preferences appear under **Memory**. Learned cards include Edit, approval/rejection, Pin, archives, usage, and revision history; there is no standalone Learning section beneath unrelated tabs. A rollback creates a new revision rather than deleting history. Source conversation/run IDs are not returned to other users. Personal lessons can only be managed by their user; shared lessons can be managed by the bot owner or an administrator. Authorization and opt-outs are checked again before committing background results.

## Controls and activation

Apply the migration with `npm run db:migrate`, then restart the web app and worker together. Migration validation runs against embedded PostgreSQL in `tests/unit/native-learning.test.ts`; the fixture applies every production migration and substitutes arrays for unrelated vector columns.

Learning defaults on for eligible native caller bots. Administrators can switch it off under **Admin → Bots & tools → Background models**. Users can switch it off under **Settings → Personalization → Bot learning**; turning Memory off also prevents procedure learning and retrieval. Set a company utility model there when the foreground connection uses personal credentials.

The review queue has one slot per worker. A persistent attempt counter caps each source run at three model attempts, including recovery after worker restarts. An outbox recovery pass runs on startup and every 60 seconds to recover reviews whose enqueue was interrupted; exhausted reviews are not re-enqueued. Review failures do not fail completed chat replies. This version records usage and loaded skill revisions but does not claim measured speedups.

## Learning quality and approval

The reviewer must skip routine repeats, fresh report values, existing-skill reuse, cosmetic rewrites and instructions that merely restate tool schemas. A new procedure needs an observed reusable method, verification, workaround or non-obvious pitfall. Existing topic names and versions are supplied separately from detailed lesson content. Identical content cannot create another topic within the same scope, even with a different title. Near-duplicate detection and material-improvement judgments still depend on the model.

Administrators can enable **Require approval for every learned skill or preference change** under Background models. New proposals remain unloaded; changes to an existing active lesson preserve its last approved revision until approval. Pending projections and rejected changes preserve the approved content and kind, including private preference Memory when the proposal is a policy. Restoring history also restores its kind. Private proposals can be managed by their user; shared proposals require the bot owner/admin. Organizational policies still require approval with the global gate off. Pinned lessons cannot be rewritten by background reviews.

Memory consent also applies to automatic persistence. **Ask me first**, organization-enforced memory approval, or organization-wide Memory disabling prevents ordinary background extraction and keeps new learned lessons pending. A foreground approval or an **Always allow** tool grant authorizes tool calls; it does not authorize a separate automatic write. Requiring approval for every learned change also prevents ordinary extraction from activating the same facts through a second store.

A stored unfinished or denied `remember` call prevents ordinary extraction from its entire source conversation and keeps that conversation's new lessons pending, including procedures that may contain the same personal fact. The check includes older turns and inactive branches, survives worker reloads, and is independent of proposal archives. Consent is checked again after generation and embedding. This deliberately suppresses automatic writes from the whole source because semantic equivalence of generated facts cannot be reliably determined. Explicitly approving a retained proposal or a later foreground memory action remains possible. Existing saved memories are not deleted or retrospectively reclassified by this change. Hermes profile memory and native review use their own controls and are outside this app-managed boundary.

## Usage and maintenance

Migration `0037_learning_usage` adds Pin, use count, last-use time, the maintenance cursor and revision kinds. Existing revisions inherit the learning’s retained classification; historical kind changes made before kind metadata existed cannot be reconstructed. New revisions retain their exact kind. `use_skill` records successful loads without creating content revisions. An unpinned active procedure shows Stale after 14 days without creation, editing or use.

The worker’s hourly `learning.curate` pass archives procedures after 30 days without creation, editing or use. It never deletes lessons or modifies manual skills, preferences or policies. Pin, native/service bot boundaries, active bot runs, current/legacy routine references, user opt-outs and organization controls are respected. Archive writes add revisions; restoring resets the grace period. The scan is bounded to 100 candidates and advances a persistent cursor, with a transaction lock serializing replicas.

Maintenance is enabled by default and can be disabled in Background models. It pauses entirely when approval is required for every learned change. Optional **Consolidate identical learned procedures within the same scope** is off by default: it retains a pinned or older identical procedure and archives duplicates while preserving their history. This is exact-content consolidation, not Hermes’s optional model-driven semantic umbrella merging. Command casing and internal whitespace are preserved when comparing procedures.
