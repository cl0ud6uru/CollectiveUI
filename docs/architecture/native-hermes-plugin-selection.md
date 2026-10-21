# Native ordinary-plugin selections

The web remote-Hermes operations panel can prepare and confirm a **pending
preference** for the exact bundled `teams_pipeline` 0.1.0 package. The selected
saved chat must already be open on the matching native socket. These operations
never hydrate a chat with `session.resume`, discover plugins, promote a selection,
activate code, reload, restart, or write shared native configuration.

The contract is `collective.plugin-selection.v1` on the reviewed Hermes source
`f97608f178d1ffeca59860195ab7da295f7c8e5f`. A separate explicit local operator
confirmation promotes pending preference to operator-committed preference. That
confirmation authorizes **subsequent native initializations, including automatic
worker starts**, to use it. It does not guarantee restart-only application or
change the current process's frozen snapshot. No promotion was run against an
installed environment while developing or validating this feature.

## Native boundaries

`install-hermes-plugin-selection.py` composes the existing recovery, workspace and
owner adapters on a clean exact source checkout. The selection handler is
registered before the owner wrapper snapshots the method table. A pure helper is
imported by `hermes_cli.plugins` before any discovery, including the normal
`serve` startup path; it reads only operator-committed flags into an immutable
per-process snapshot. Newly spawned workers cannot consume pending flags.

The portal's inspect/select RPC requires the current full owner, exact transport,
attached session and matching native profile. The owner profile lock precedes
the session history lock and sidecar lock. All native profile work, queues,
delegations and retained slash-worker handles keep selection unavailable. The
launch profile and at most 500 existing profile names are captured; uncaptured
or later-created profiles fail unavailable rather than promising application.

The only positively classified source is the literal bundled canonical key,
manifest name and version above. All nine reviewed package source/manifest
digests, fixed path, standalone kind and absence of tool/hook declarations are
checked. Initialization also checks the effective manifest winner and every
canonical/leaf/name collision before applying the selection. Changed, shadowed
or ambiguous packages keep native behavior. Managed installs/config overlays and
bundled-path overrides are unsupported. No plugin settings, installation paths,
schema values, credentials or full config are returned.

This is **reviewed source identity within an operator-trusted native
installation**, not executable/bytecode attestation or a defense against local
code-directory replacement. Ordinary Python caches are accepted. A local actor
able to replace source, cached bytecode or the adapter is outside this boundary,
as with the existing native adapters. The portal never executes that code while
storing preferences.

Pending and committed values live in the profile's adapter-owned
`.collective-plugin-selection.json`. No-follow descriptor-relative I/O rejects
links, non-regular/oversized data and malformed identity/schema. A separate
`flock`, exact raw revision, monotonic generation, atomic replacement, fsync and
readback protect cooperating native writers across processes. Shared
`config.yaml`, including its raw env references and auth/security/provider
settings, stays byte-identical. Arbitrary out-of-band filesystem writers are not
made transactional by this protocol.

The portal adds expiring encrypted confirmation, owner/connection/chat/profile/
runtime/socket binding, a durable PostgreSQL receipt before dispatch, native CAS,
and separate authoritative readback. Duplicate or ambiguous submissions never
replay; an ambiguous outcome remains uncertain. A duplicate reports the current
stored preference without claiming that its original submission completed.

## Local operator review

These are reviewable commands for an operator; none is invoked by the portal:

```sh
# Source validation only; no source/profile/runtime change.
python scripts/install-hermes-plugin-selection.py --hermes-source /path/to/exact/hermes

# After a separately reviewed source installation, inspect the pending revision.
python scripts/confirm-hermes-plugin-selection.py --hermes-source /path/to/exact/hermes --profile work

# Explicitly authorize future initializations, including automatic workers.
python scripts/confirm-hermes-plugin-selection.py --hermes-source /path/to/exact/hermes --profile work \
  --expected-revision REVIEWED_REVISION --expected-identity REVIEWED_SOURCE_IDENTITY \
  --confirm-future-native-initializations
```

The local command verifies the pin, installed helper bytes, source identity and
exact pending revision. Its default inspection is read-only; confirmation changes
only the same adapter-owned sidecar. Once committed, that one plugin's selection
overrides native allow/deny configuration during later initialization. Native CLI
allow/deny edits do not clear it. To return to native configuration, the operator
can remove this separate preference file while the profile is stopped and then
initialize again. The portal exposes no arbitrary file removal.

The UI distinguishes pending preference, operator-confirmed preference, frozen
process-start preference and **loaded state: unreported**. Inventory `status`
describes native configuration, never proof of a running registry. Controls are
web-only because iOS/macOS currently have no native remote operations panel;
their existing chat/commands/settings destinations are unchanged. Direct plugin
toggle, install/update/removal, settings, arbitrary plugins, source downloads,
automatic promotion and service management remain unsupported.

## Regression evidence

`tests/native-plugin-selection.py` uses a tracked exact-pin archive and disposable
homes. It proves true two-process CAS, unchanged raw config, stale revision/source
refusal, links, exhaustion, managed paths, normal caches and the explicit source
trust residual. It captures the actual `_SlashWorker` child environment and runs
the actual patched initializer with synthetic manifests/gate callbacks: pending
is invisible; explicit local promotion affects only subsequent initializations;
later pending changes cannot overwrite committed selection or a frozen process.
No plugin is imported or executed.

`remote-hermes-plugin-selection.test.ts` adds the actual ASGI/WebSocket dispatcher,
native owner fence, current adapters, real portal routes and PostgreSQL at pool
size 1. It verifies adapter source hashes, receipt-before-write, readback, no
replay, stale CAS, foreign/unclaimed requests, profile-wide work and an uncached
chat refusal. Guarded discovery/toggle/activation paths and hydration counters
remain zero for selection; raw config stays identical. The headless operations
browser checks explicit confirmation and pending/committed/startup/loaded copy.
The hosted native job explicitly enables both native and gateway proof.
