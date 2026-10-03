# Hermes provisioning verification — 2026-10-02

Branch: `feat/hermes-profile-provisioning`; draft [PR #13](https://github.com/cl0ud6uru/CollectiveUI/pull/13). Tested base: `d5abf7437745fe138751a5ecb6d2d186d3ad7087`. This report covers the corrective changes after published head `6c44d2184014ee5ba87e975097c1a5c758d3285e`.

## Review findings and corrections

The earlier focused review and 559-unit/50-database-test pass missed editor, authoring, cold cancellation and regeneration paths. Its conclusion was too broad. Independent diagnostic probes reproduced the defects before implementation changes; regression tests now exercise the actual server actions, API route and AI SDK against disposable PostgreSQL.

| Finding | Correction and evidence |
| --- | --- |
| Editing a managed bot's name/instructions could invalidate every user's assigned profile. | A modular mutation guard rejects definition/app changes before writes. Edit/delete and reservation share a bot-row lock; reservation rereads the spec under it. Two-user tests preserve both profile IDs and still allow appearance, label, starters and ACL edits. The editor fixes definition fields. |
| Ordinary create/copy/template flows could create additional managed bots and consume another chatting user's lifetime quota. | Each managed app has a server-owned approved `managedBotId`. Generic authoring and execution reject other bindings. Admin creation binds the app/bot atomically. Legacy approval is explicit and refuses conflicting assignments. Creation alone never consumed a profile slot; the defect required first use. |
| Legacy edits needed a usable recovery path. | Admin-only restoration verifies the original text against **every** retained assignment under locks, then restores and approves atomically. Wrong text, another bot and ordinary-user requests are refused. Profiles and memory are preserved. Original text must come from operator records; only its hash is stored. |
| Cold supersession used the unscoped stop helper, which cannot resolve managed profiles. | Supersession uses the shared provider-stop service and persisted target/provision binding. A database regression with no parked stream proves a scoped stop, pending outcome and later confirmed reconciliation. Normal new-turn admission already rejects approval waits; this was a cold/race/legacy path defect, not a guaranteed ordinary-turn trigger. |
| Ready turns incurred seven sequential remote reads and redundant database authorization reads. | Exact health/version checks precede six overlapping independent reads. Authorization remains fresh before **every** dispatch. Joined binding reads and reuse within resolution reduce the measured LDAP fixture cost from 53 to **41 database queries**, with seven remote reads retained. Tests prove overlap and refusal when the runtime is disabled after the health response. There is no authorization cache. |
| Provisioning catch-all hid ownership conflicts and revocation behind retryable 503 text. | Controlled `HttpError` status/diagnostics survive; the reservation records the safe operator-action cause. Foreign-marker regression returns 409, issues only GETs and never alters that profile. Unknown/upstream diagnostics remain suppressed. |
| Failed regeneration marked the already-stored prompt unsaved, removing it from the UI and restoring it into the composer. | The API checks persistence and returns an exact `unsavedMessageId` only for a new absent message. Regeneration and duplicate IDs cannot trigger draft rollback. Approval retry uses a separate exact ID. Actual API/SDK and Chromium regressions preserve the stored prompt and empty composer when runtime-disabled regeneration fails. Queue failures after storage cannot mark a saved prompt unsaved. |
| Every connection database failure appeared to be duplicate registration. | Controlled errors and SQLSTATE 23505 are separated from other failures, which return a safe service-unavailable response. Tests inject an outage and exercise actual uniqueness rejection. No SQL/secret text is returned. |
| Dynamic untyped error flags, duplicated rotation validation and repeated stop lookups complicated these paths. | Removed `Object.assign(..., {unsaved:true})`; response IDs have explicit client checks. Shared secret validation and a store-level token rotation function replace inline action logic/dynamic decryption imports. Stop reconciliation uses its trusted run fields and one managed-mode check. |
| Deleting an assigned bot/app could destroy the identity needed for cancellation. | Normal actions refuse assigned-bot deletion and managed-app deletion; admins can disable instead. Retained reservations and remote memory are never automatically cleaned up. |
| Older valid managed definitions exceeded generic editor input limits. | New creation uses the ordinary limits; existing managed definitions retain 100-character-name/24,000-character-instruction compatibility for metadata edits. Ordinary bots retain their previous limits. A regression preserves the long definition's profile ID. |

The internal independent Astra reviewer found the recovery and field-limit gaps during corrective review; both were fixed and re-reviewed. The final focused source review reported no remaining confirmed finding. This is scoped review evidence, not a guarantee that no defects exist.

## Completed checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed without warnings |
| `npm test -- --project unit` | 56 files / **560 tests passed** |
| Targeted disposable PostgreSQL integration | 7 files / **60 tests passed** |
| Final focused database rerun | **22 Hermes tests passed**, including strengthened pending-to-confirmed stop reconciliation |
| `npm run build` | Passed |
| Chromium against the built production app | **1 expanded end-to-end scenario passed** |
| `git diff --check` | Passed |
| Fixture credential scan of web/worker/fixture logs | Zero matches for the supplied fixture credentials |

The database files are `hermes-provisioning`, `hermes-provisioning-upgrade`, `hermes-commands`, `pets`, `roster`, `bot-home`, and `secrets-rewrap`. The upgrade test used a fresh named disposable database and verifies preservation of manual Hermes history/preferences and private pet data, plus migration idempotency. An initial rerun encountered old test IDs in the reused upgrade database; recreating only that task-owned database resolved the fixture-state failure. No schema correction was needed.

The browser scenario covers admin runtime registration, owner selection, token replacement, direct replay of an admin action by an ordinary user, missing runtime, failed setup and restored draft, retry, two users on one bot, `/new`, runtime-disabled regeneration preserving the saved prompt, frozen editor fields, and mobile layout. Its first run reached the editor assertions but used an unassociated label selector; the corrected test uses the existing field structure. The final scenario passed. No production source change was required for that selector fix.

Commands (with the synthetic `/tmp/collective-profiles.env` loaded):

```sh
npm run typecheck
npm run lint
npm test -- --project unit
HERMES_PROVISIONING_DB_TEST=1 \
HERMES_UPGRADE_DATABASE_URL=postgres://postgres@127.0.0.1:5547/collective_profiles_upgrade_test \
npm test -- --project integration \
  tests/integration/hermes-provisioning.test.ts \
  tests/integration/hermes-provisioning-upgrade.test.ts \
  tests/integration/hermes-commands.test.ts \
  tests/integration/pets.test.ts \
  tests/integration/roster.test.ts \
  tests/integration/bot-home.test.ts \
  tests/integration/secrets-rewrap.test.ts
npm run build
npx playwright test --config=playwright.hermes-provisioning.config.ts
git diff --check
```

Evidence: `/tmp/collective-fix-{typecheck,lint,unit,db-full,db-focused,build,browser}.log`; screenshots in `/tmp/collective-hermes-screenshots/`, including `regenerate-preserved.png`. PostgreSQL used loopback port 5547; synthetic HTTP listeners used ports 19100–19103 and the production app used 3307. The task-owned web, worker, HTTP fixture and PostgreSQL processes were stopped after validation.

## Protocol and activation limits

All remote behavior was tested against synthetic mocks, with synthetic accounts/credentials and disposable databases. **No live Hermes conformance, real profile creation, real credential change, deployment or production database write occurred.** Source compatibility is pinned to Hermes `be5e9f72c6681af9dfb75bf480f08844f1499949`; the profile-alias model listing, blank-create fields and dashboard token contract were checked against that source in the earlier implementation review. Mock success does not prove live upstream conformance.

Operators must supply and independently verify whole-process/filesystem isolation per user, external-memory scope, protected dashboard processes/token/listener, equivalent authenticated loopback forwarding in every web/worker namespace, the pinned deployment, provider/profile keys, gateway readiness and resource budgets. Profiles are not tenant security boundaries. The implementation creates no isolation, container, tunnel, sidecar or proxy and uses no host Docker socket. Dashboard administration must remain inaccessible to the agent's whole process tree.

Managed mode supports direct bot chats, three environment-key providers, empty initial skills and explicit toolsets. It does not implement remote cookie-auth dashboard flows, skill installation, managed group/delegated/background runs, endpoint/key migration, raising capacity or destructive profile cleanup. Disabling blocks future dispatches; already-dispatched work requires operator containment. See [architecture and operator prerequisites](../architecture/hermes-profile-provisioning.md).

## Integration coordination

These corrections add **no migration or schema change**. PR #13 retains its published `0013_hermes_provisioning`; main remains `d5abf74` at the final pre-publication check. Do not silently renumber an already-published migration.

The separately coordinated general-fixes branch `fix/verified-review-issues` at `21c569640d323cf4bca7557a397c732a18cac4a5` changes the shared bot-action transaction and adds its own `0013_nebulous_callisto`. That branch was not imported or tested here. Sequential integration must resolve the two 0013 migrations and preserve `guardManagedBotMutation(tx, ...)` inside the combined bot/relation transaction, using the same bot-first lock order as provisioning. Its delegation, DNS, routine-admission and group-image changes remain outside this corrective branch. No visual or pet implementation was changed.
