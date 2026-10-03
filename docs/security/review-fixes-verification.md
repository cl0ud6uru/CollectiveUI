# Review fixes and combined integration verification

Verified locally on 2026-10-02 using synthetic data and isolated PostgreSQL, LDAP, model and Hermes fixtures. The five findings were reproduced against the starting main history (`d5abf74`); none was already fixed. The implementation checkpoint was `21c5696`. Integration incorporates current main `b2a0205` (including PR11) and Hermes provisioning `db34aa3` through `9cb2baf`.

## Corrected behavior

- Delegation checks the acting user's access during discovery and refreshes identity, source/target access and delegation edges before execution, including nested calls. Tests cover private knowledge, owner and group access, membership/edge/disabled-user/disabled-bot revocation.
- Web requests connect to the validated DNS address, preserving the original HTTP host and TLS name; each redirect is validated again. Deterministic tests cover rebinding, mapped IPv6, redirects, approved loopback fixtures, response limits, invalid status codes and aborts. No real internal services were probed.
- Bot content, tools, delegates and audience relations commit in one transaction, including creation/copy paths. A stale group cannot expose new content to the old audience. Concurrent-edit tests assert complete matching states. The managed-Hermes mutation guard runs inside the same transaction and row lock as these writes.
- A queued routine row is a durable admission outbox. Schedule advancement and row creation are atomic; the sweeper fairly retries lost/failed admissions using the same run ID, and execution is claimed once. Coverage includes real pg-boss queue failure, concurrent delivery, crash recovery, retry fairness and invalid timezones.
- Group turns preserve authorized structured image parts across teammate handoffs. Tests cover two users, foreign attachments, vision/text-only models, unreadable storage and the six-reply limit.

## Migration lineage

Published `0013_hermes_provisioning.sql`, its snapshot and journal timestamp remain unchanged. Drizzle generated `0014_routine_admission_outbox` from that snapshot; it adds only nullable `routine_runs.last_enqueue_at`. The combined migration suite passes for fresh installation and upgrades from main `0012` and Hermes `0013`, including repeated migration, preserved manual/managed Hermes identities and stop bindings, conversations/messages, pets and queued routines.

## Checks

- `npm run typecheck`, `npm run lint`, `npm run build`: passed.
- Unit suite: 58 files, 577 tests passed.
- Broad integration suite: 18 files, 138 tests passed; 39 opt-in tests skipped in that invocation.
- Separately enabled Hermes/runtime integration: 6 files, 62 tests passed (overlaps the broad suite). This includes the 25 provisioning tests skipped above, with managed relation rollback and actual delegate/group/routine rejection before provisioning.
- Separately enabled combined migration suite: 3 tests passed; real pg-boss admission/recovery: 1 test passed.
- Production-build Chromium: 7 general scenarios passed (duplicate bot, group handoff, group image upload and four login/accessibility scenarios); the full Hermes provisioning scenario passed separately. A login cleanup test was made to wait for React's effect listeners before its first pointer event, removing a hydration timing race in the test.
- Independent source review of the five fixes and combined authorization/transaction/migration changes found no remaining blocker. Whitespace checks passed.

The remaining opt-in integration coverage requires live Hermes or separate legacy local-auth/LDAP/migration fixtures and was not claimed by the broad invocation. Live Hermes conformance, operator isolation and external-provider behavior remain activation prerequisites; synthetic fixtures cannot establish them. Docker sandbox execution and a full browser matrix were not run. No deployment, real credentials, live profiles or live user data were changed. These checks cover the stated regressions and integration paths, not all possible defects.
