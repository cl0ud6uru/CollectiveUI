# Native plugin preference boundary

At candidate `6814d3d`, the actual operations POST imports `projects.ts` and
`workspace-edit.ts`. Its request and encrypted claim schemas reject plugin
preparations and confirmations. An older `operations-mutations.ts` implementation
was unreferenced dead code, not an exposed API. It has been removed because its
upstream toggle path is unsuitable for the offered controls. Six actual POST
regressions reject both plugin preparation actions and enable/disable claims
encrypted with either the old workspace AAD or the current project AAD, before
native inventory, dispatch, receipts or admission locks.

The inspected Hermes source is exactly
`f97608f178d1ffeca59860195ab7da295f7c8e5f`. Its enable RPC can force a reload of
every profile plugin, refresh secret sources and re-register config/outbound
hooks. Even its disable path can discover plugins through the toolset helper.
No current portal operation may call those paths. Native list `status` derives
from configuration; it is not proof of the running registry's loaded state.

A preference-only shared-config adapter also lacks the required transaction
primitive. The native config lock is a process-local `threading.RLock`.
`atomic_config_write` replaces full state without an expected revision; an
unrelated caller can prepare an older snapshot outside the lock. A target-only
SHA-checked update under that lock does preserve unrelated raw settings in
isolation, but native `save_config` and `atomic_config_write` callers can each
overwrite it with their older unrelated save. Conversely, a separate process can
save an unrelated setting between the preference revision check and full-state
write; the preference write then erases that setting despite holding the lock.

Reproduce with a **clean source checkout** and the Hermes dependency environment:

```sh
python scripts/prove-hermes-plugin-config-cas-gap.py --hermes-source /path/to/pinned/hermes-source
```

The diagnostic creates and removes its own synthetic Hermes home, refuses a
different or dirty source pin, prohibits sockets, and exercises the actual
native config writers. It never invokes plugin discovery, toggle, activation,
reload or restart. Synthetic security/auth/provider fields and literal env
references establish preservation without reading real configuration. The
separate child process also uses only this disposable home.

The implemented bounded alternative is an adapter-owned per-profile selection
sidecar with its own cross-process lock, revision and generation. Portal writes
change only pending selection. A separate explicit local operator promotion
commits a selection for subsequent native initializations, including automatic
workers. The portal never promotes or loads code. Immutable per-process snapshots
read only committed values; new workers cannot consume pending preferences.
Canonical source/path/name/version/digests and effective winner/alias gates apply
within the operator-trusted native installation. Ordinary caches are accepted;
this is source identity, not executable attestation. See the
[complete contract and proof](../architecture/native-hermes-plugin-selection.md).
Keep #95/#100 open until this increment's independent review, exact-head CI and
merge gates complete. No production installation or local operator promotion has
been performed outside disposable synthetic fixtures.
