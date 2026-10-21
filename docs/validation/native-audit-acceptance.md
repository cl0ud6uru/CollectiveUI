# Remote Hermes audit acceptance: #90, #95, #96, #100

Checklist readback: the four live GitHub issue bodies on 2026-10-21. PR341's reviewed
native implementation was merged as `a26d60f03e96b8c004cbd419e2491a344948c1d9`;
the parent audit confirmed post-merge CI and Docker publication passed. Issue #90/#96
closure audit remains with the parent. This is an implementation/evidence mapping,
not an issue closure, deployment or installed-server acceptance. The separate plugin
selection increment below still requires its own final review, exact-head CI and merge.

The actual pinned native source is Hermes `f97608f178d1ffeca59860195ab7da295f7c8e5f`.
The owner-core module/installer match reviewed `398096de08920bca0b86787c4e9d81b3c41ff5d0`.
Portal hub/socket/sessions/recovery/ownership and native owner/drain runtime bytes are unchanged
from independently reviewed integration `0c6dbcf506afbf24281cb586122d2feb9f855d9b`.
Current workspace proof is detailed in [full gateway validation](native-workspace-full-gateway.md).

## #90 — admission and queue recovery

| Exact acceptance criterion | Implementation and evidence | Candidate status |
| --- | --- | --- |
| Proven pre-prompt rejection releases admission safely. | `sessions.ts` sets the prompt dispatch boundary before send and releases only the matching still-admitting reservation after definite attachment rejection or unsupported prompt method. `remote-hermes-reservations.test.ts` covers image/PDF/file rejection, detach failure and a late failed upload against a newer reservation. | Implemented. |
| Ambiguous submission never automatically replays. | Content-bound `remote_hermes_turns` receipts precede dispatch; unknown replies retain reservations. Unit lost-ack/reload/Stop cases and real PostgreSQL reservation cases preserve receipts. The separate process-loss runner kills the first portal runner and proves the successor does not replay its prompt. | Implemented. |
| Native evidence or explicit safely-confirmed operator recovery can settle stuck reservations. | The explicit owner-confirmed recovery path persists its intent, uses recovery-only native ownership plus exact cancel-and-drain proof, promotes only after tracked workers end, then applies a revision/generation/reservation CAS. Actual gateway/PostgreSQL cases cover lost acceptance, a live interrupt-ignoring worker and lost promotion acknowledgement. | Implemented for the documented pinned adapters and supported native runtime scope. Missing/process-changed evidence remains blocked; no force reset is claimed. |
| Queue consumption and late acknowledgements remain fenced. | Durable queue request IDs/revisions, observed native queue evidence and snapshot ordering fence settlement. PostgreSQL tests admit only one concurrent queue and reject a late acknowledgement after a different queue is admitted. | Implemented. |
| Regression tests cover attachment rejection, lost acknowledgements, reload and Stop. | Reservation units cover all listed triggers and both Stop shapes; real PostgreSQL reservation and actual gateway recovery suites add process loss and terminal evidence. Original attachment/unsupported/Stop regressions were run red before their fixes, as recorded in the recovery contract. | Covered; final exact-head CI remains required. |

Recommendation: #90 has the supported merged native-evidence implementation and green
publication; the parent must complete the closure audit. Neither ordinary idle state nor deployment absence is treated
as terminal proof. No production rollout is required or authorized by the issue.

## #96 — distributed ownership

| Exact acceptance criterion | Implementation and evidence | Candidate status |
| --- | --- | --- |
| Define durable hub/session ownership with fencing and failover. | PostgreSQL lease owner/generation/socket epoch plus a separate durable SQLite native profile generation. Every native handler/answer and delayed worker start checks the exact transport-bound claim. Cold refresh/view tests reject an unexpired foreign lease and take over an expired lease without replay. | Implemented for the pinned native-owner adapter; unsupported takeover fails closed. |
| Two web instances cannot submit or answer twice. | Distinct production `NativeHub` instances/identities compete through actual PostgreSQL and the real native owner wrapper. Old/unclaimed WebSocket and stdio requests/answers are rejected; the full owner settles one exact protected waiter once, and stale request IDs cannot repeat it. Queue concurrency is additionally proved with PostgreSQL and distinct runner processes. | Covered at the production hub/native dispatch boundaries. This is not a two-host deployment exercise or general exactly-once claim. |
| Restart recovers authoritative state without mutation replay. | Durable receipts/leases survive the separate-process SIGKILL fixture. Cold owner/reconnect cases retain native history and runtime without another turn. Native process-changed/pending evidence remains uncertain; it never authorizes automatic replay or release. | Implemented with conservative uncertainty. |
| Add two-instance tests and deployment requirements. | `remote-hermes-owner-conformance.test.ts`, `remote-hermes-portal-recovery.test.ts`, `remote-hermes-reservations.test.ts` and actual PostgreSQL dispatch-lock tests. The ownership/portal recovery contracts document exact adapter pin/order, shared portal PostgreSQL, durable native profile state, WebSocket transport, and fail-closed version behavior. | Covered; primary deployment wording is aligned by this documentation update. |
| Preserve secret/server-request routing and bounded resource usage. | Owner/lease/recovery records retain identity/proof, not prompt answers or credentials. Actual protected-request tests reject foreign/unclaimed/missing/stale request routes and assert that answers are absent from native history. Existing bounded transport and response projections remain. Accepted auxiliary/background workers cannot enter after losing their owner claim. | Covered within the reviewed protocol and fixture boundaries. |

Recommendation: #96 has the reviewed merged implementation and green publication; the
parent must complete the closure audit. A sticky router or
PostgreSQL lease alone is not the native fence. Operators still need separately reviewed installation
and compatible runtime state before multi-instance rollout; no such rollout occurred here.

## #95 — projects, workspace, schedules and plugins

| Exact acceptance criterion | Implementation and evidence | Candidate status |
| --- | --- | --- |
| Decompose independently reviewable project create/select, safe file access, schedule and plugin controls. | Preserved component histories separate read/list (#264), project create/select and schedule pause/resume (#271), file edit (#281), and required owner/drain foundations. Plugin inventory remains projected; the new separate ordinary-plugin preference increment adds confirmed pending selection, native CAS and explicit local operator promotion for future initialization. Direct activation/install/removal is unsupported. | Bounded plugin preference implementation added; final review, exact-head CI and merge are pending. |
| Establish runtime capabilities, workspace authorization, traversal/symlink and secret boundaries first. | Exact selected owned chat/profile/project/local-backend binding, full native owner claim, history lock across idle check/I/O, descriptor-relative no-follow opens, protected/hidden/token/hardlink/device gates and bounded UTF-8 files. Actual gateway tests include unclaimed/stale/foreign/busy/native-profile mismatch; dispatcher tests cover both admission races. | Implemented for supported local-project files. |
| Explicitly confirm disruptive operations. | Encrypted short-lived confirmations bind owner, connection, selected saved chat/runtime/profile and socket. Project/schedule mutations and file edits use durable one-shot receipts and authoritative readback. UI explains profile-wide effects and schedule usage; ambiguous outcomes never replay. | Implemented for offered mutations, including source/revision-bound pending plugin selection; local promotion has its own explicit operator confirmation. |
| Tests prove no arbitrary filesystem/dashboard access. | Fixed native methods and server-derived roots; no `/api/fs/*` forwarding. Twelve dispatcher cases, six actual gateway cases and focused operations/project/edit units cover traversal, symlink, hidden secrets, hardlinks, stale digests, path/identity alteration, unsupported backends and bounded FIFO handling. | Covered with documented same-device mount/out-of-band writer residual limits. |
| Document remaining unsupported operations. | Workspace contract lists folder attachment, project editing/archive/removal, file create/remove/rename, schedule create/remove and direct plugin activation/lifecycle mutations as unsupported, plus exact-pin and installed-server limits. | Documented; documentation alone does not complete plugin controls. |

Recommendation: keep #95 open until the separate plugin preference increment completes
independent review, exact-head CI and merge. Its [precise contract](../architecture/native-hermes-plugin-selection.md)
supports pending selection for only the positively classified bundled source. Portal writes cannot
promote, activate, discover or reload. Explicit local promotion authorizes subsequent native
initializations, including automatic workers; loaded state remains unreported. The existing upstream
toggle and shared-config CAS are excluded, as recorded in [boundary validation](native-plugin-preference-boundary.md).
Broader lifecycle operations remain explicitly unsupported; no direct activation or installed-server
compatibility is inferred from source tests or UI preferences.

## #100 — parent tracker

The tracker requires all child acceptance criteria, independently reviewed code, red/green regressions,
PR readback and exact-head CI. The refreshed tracker marks its other children closed.
Keep #100 open while #95 is partial or any #90/#95/#96 delivery gate is pending. Do not change the
tracker's three unchecked boxes merely because PR341 contains source or a local suite passed.

## Provenance and limits

Independent prior owner/recovery verification at the unchanged runtime pins: 17 actual gateway/PostgreSQL
cases (11 owner, 6 recovery), 8 PostgreSQL dispatch-lock cases and 7 reservation/process-loss cases.
Final composed candidate verification: 23 actual gateway/PostgreSQL cases at application pool size1;
fresh independent repeat of 6 workspace gateway, 12 dispatcher and 36 operations/project/edit units.
CI now explicitly enables owner/recovery/workspace proof rather than relying on ordinary skipped suites.

These fixtures use actual ASGI/WebSocket/native dispatch and native SQLite storage with synthetic
authentication and agent construction. The process-loss queue test and SQL lock cases are distinct from
the real native gateway cases. No live provider inference, real credential, installed default-profile
compatibility, GUI, production deployment or account/security configuration is claimed or performed.
