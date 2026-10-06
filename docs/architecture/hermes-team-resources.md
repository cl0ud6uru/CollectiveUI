# Hermes Team Bot resource revisions

`src/lib/hermes-team/resources.ts` defines a bounded JSON resource manifest for
immutable reviewed publications. Each resource has its profile-relative path,
kind, package ID, exact bytes encoded as UTF-8 or canonical base64, byte count,
and SHA-256 hash. The snapshot hash covers the canonical ordered manifest. No
skill script is evaluated during capture, review, validation, or update planning.

A publication contains only explicitly selected complete directories beneath
`skills/`, `SOUL.md` when selected, and explicitly selected files beneath
`documents/`. A skill directory must include its `SKILL.md`; scripts and assets
are included with that package. Overlapping packages are rejected. Review and
publication must select whole package IDs from the captured snapshot and persist
those exact bytes, rather than re-reading an evolving profile when Publish is
clicked. `reviewTeamResourceChanges` provides added/changed/removed whole-package
units with previous and captured bytes. `selectTeamResourcePublication` checks
both expected snapshot hashes and merges explicitly selected changes and removals
into the previous publication. It rejects per-file picks, duplicate keys, and
removals absent from the frozen review. Unselected old packages remain published.
Removing an item from a publication is an explicit revision change.

Capture rejects path traversal, encoded/Windows path ambiguity, symlinks,
hardlinks, special files, and overlapping file/directory paths. It excludes
hidden files and authentication, credentials, configuration, personal memory,
conversation/history, browser/session, log, and cache paths even inside selected
packages. Default limits are 256 files, 1 MiB per file, 8 MiB per snapshot, 256
bytes per path, and 16 path segments; deployments may lower these limits. The
traversal has a separate bounded entry budget. Credential-like tokens, private
keys, and credential assignments in otherwise allowed content cause rejection.
This content check is defense in depth: arbitrary prose or novel credential
formats cannot be proven secret-free. Maintainers still review actual content.

The capture adapter runs in a Linux volume helper and receives a profile root
only from an authorized server-side runtime binding. It opens child paths through
held directory descriptors and `O_NOFOLLOW`, preventing a parent directory from
being swapped for a symlink between checks. Bounded reads verify inode metadata
before and after reading; two scans separated by a settling interval must match
metadata and content hashes. A caller must also hold the broker's exclusive
runtime maintenance lease and quiesce native writes across capture. Equal scans
alone do not guarantee a stable writer-free interval. Docker profile volumes are
not assumed to be host-visible, so these helpers do not imply a supported live
broker capture capability before the volume helper is packaged and verified.

## Member reconciliation

`src/lib/hermes-team/updates.ts` compares the last offered team snapshot, target
revision, and complete current member resources. The current inventory must
include new files inside tracked packages and separately learned packages.
Partial package inventories cannot safely decide whether a member changed a
script or deleted a file. Current snapshots can include an incomplete package
when a member intentionally deleted its `SKILL.md` or another file.

Skill packages reconcile atomically. An unchanged team copy receives the target
version. A changed package produces a conflict if the team also changed or
removed it. Independently learned packages remain untouched; a new team package
colliding with one produces a conflict. Member-deleted packages receive durable
tombstones that survive team removal and reintroduction. A member-added asset or
partial deletion is a package modification and is preserved with the package.

A private conflict preview includes exact member and team resources. Keep my
version records a persistent member override. Use team version explicitly resets
that override or deletion, and plans the full target package. Resolutions require
both preview hashes to match current content, rejecting stale review screens.
Rollback is an update to an earlier immutable snapshot using these same rules.
The admin rollout helper returns only counts, without private package contents,
paths, or member hashes.

## Update receipts and runtime integration

The update engine also provides a pure persisted receipt state machine. It does
not itself write native profile files. `beginResourceUpdate` binds an operation ID
to one immutable plan; persist that receipt before starting writes. Under the
exclusive maintenance lease, `nextResourceUpdateStep` checks the next package's
actual complete hash. A before hash allows application. An after hash recognizes
an atomic replacement completed before a crash and advances without duplicating
it. Any other hash blocks recovery with `needs-attention` instead of overwriting
partial data or new learning. A verified result is recorded with
`recordResourceUpdateApplied` before continuing. Repeated requests for a completed
operation perform no writes.

A runtime adapter must stage complete skill packages outside native profile
state and replace them atomically, use safe server-derived paths, and retain
operation receipts outside learning resources. Role/document replacement also
needs atomic file writes. Receipts resume interruption between groups; they do
not claim a multi-directory release is one atomic filesystem transaction. The
adapter must exclude concurrent native writes and reads during application and
must persist installed revision/overrides only when every writable group is
complete. Outstanding conflicts remain preserved and need their own durable
status. A partially written package is blocked until explicitly reconciled; it
must never be treated as a completed install.

## Verification

Synthetic unit fixtures cover exact binary assets and scripts, private-file
exclusion, embedded credential detection, malicious paths and links, FIFO safety,
settling changes, manifest corruption and bounds, whole-package conflicts,
member learning/deletions, stale choices, rollback, deterministic plans, private
rollout summaries, repeated operations, persisted receipt validation, crash
recovery, and refusal to replay over partial changes. The tests require no live
model calls, OAuth grants, production data, or credentials.
