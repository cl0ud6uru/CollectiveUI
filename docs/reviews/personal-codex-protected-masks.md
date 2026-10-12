# Personal Codex protected-mask investigation

**Historical investigation:** the approved direction is now the [official stock-runtime route](personal-codex-stock-runtime.md). This source patch and its planner results are preserved but are not used to build or accept that image.
This is a proposed patch to pinned **native Codex**, plus a stricter disposable proof. It does not activate or replace the runtime. Production requirements, npm/image pins, the broker, Hermes and browser-runtime paths are unchanged. Production remains disabled.

The branch starts at CollectiveUI main **015b091868fa0878c298b856c14d059342f5d9e9**. Operator commit **946723b1a9e26da2ca0b9dd017b18e734d1d1a36** was inspected without accessing its VM; its reviewed-profile files are now included in main. The new probe uses that fixed hash-verified importer when a profile is selected. No host profile, capability, security permission, account, credential or network rule was changed by this work.

## Why a policy workaround is unsafe

The source pin is [OpenAI Codex a6274249d5877030676db098914db686bab7c921](https://github.com/openai/codex/tree/a6274249d5877030676db098914db686bab7c921), distributed as 0.163.0-alpha.2.

In native linux-sandbox/src/bwrap.rs:

1. The planner filters explicit denies out of read-only subpaths, then adds automatic metadata masks again. A missing workspace .codex therefore receives both an empty-directory read-only mask and an empty-file deny mask. This matches the operator's “Is a directory” failure.
2. A denied home receives an empty read-only tmpfs. The planner then tries to create denied auth/config/history/session child mount targets within that frozen empty view. This matches the operator's “Read-only file system” failure.

Removing home or metadata denies, narrowing them to known files/globs, or making the home merely read-only would weaken the protection. Requirements remain byte-for-byte unchanged, SHA-256 **0ac28a075138ce8dba7d8916f726f97743c030da7d769e168fd8a18dca969b66**.

## Proposed native change

[The source patch](../../patches/codex/a6274249-protected-masks.patch) applies only to the exact pinned source. It is not installed by the production Dockerfile.

- Filter metadata masks after automatic metadata protection is added, so an effective explicit deny gets one physical mask.
- Coalesce nested physical deny mounts only under an existing denied directory with **no writable descendants**, including canonical aliases. Keep every logical deny.
- Validate every original deny at its original native mount-planning position, after writable-root alias remapping, even when its redundant physical mount is skipped. Preserve mutable-symlink rejection.
- Preserve synthetic-target cleanup and missing-metadata creation monitoring.
- Add five focused regressions: missing/empty/populated metadata, nested home denies, covered mutable symlink, writable descendants below denied children, and canonical writable aliases.

An initial global validation pass rejected legitimate workspace aliases; the revised patch preserves native remapping before validation. Independent read-only review found no remaining blocker in the revised coalescing approach.

## Verification and its limits

The selected bwrap planner suite is compiled from the pinned native source plus the patch. Baseline plus the new regressions gives **56 passed, 2 failed**, reproducing the two reported collisions. The revised patch gives **58 passed, 0 failed**. The 57 focused CollectiveUI proof/broker/Docker/operator-policy tests pass. Typecheck and focused lint pass. Exact patch application against clean pinned source also passes. This is mount-plan evidence, not bubblewrap execution.

Local build details: Rust 1.95.0; test/dev debug information and incremental compilation disabled. The cloud has limited disk space, so the unused codex-core dev dependency was omitted from the temporary local manifest for library-only compilation. No production manifest or lockfile change is delivered. The upstream lock required local regeneration; its dependency reconciliation must be reviewed separately before a release build.

The executor hides its own native daemon directory. Compiled planner tests were therefore run as uid10001 in disposable network-none, read-only, cap-drop-ALL containers with their own tmpfs. Four public runtime libraries and the test binary were mounted read-only to match the compiler's libc. These extra mounts are only for planner unit tests. The actual enforcement probe uses exactly its two fresh fixture volumes and no host mounts.

The credential-free enforcement result is recorded in [the evidence JSON](personal-codex-protected-mask-evidence.json). The official unpatched fixture passes protocol, policy-file hash and container-boundary checks. Native commands fail for all three metadata states, so no protection is credited and verified is false. No patched production image, native tool turn, real subscription, account sign-in, VM enforcement or live runtime has been verified.

Two further native gates remain explicit:

- The active readonly arg0 helper is logically granted beneath the denied home; this patch does not reopen it. Execute that exact helper alias and verify it stays read-only with auth still hidden.
- Native create_bwrap_flags appends a fresh /proc after filesystem masks. Verify the explicit /proc deny survives; ordinary shell success alone is insufficient.

Both may require separately reviewed native fixes. Do not remove denies or relax host policy to obtain a green probe.

## Exact no-credential proof for Hermes

Hermes remains the sole VM operator. The steps below require a reviewed custom native build/image and approval to run disposable fixtures on the nominated VM. They do not authorize installation, deployment, real sign-in or security/network expansion.

1. Use a reviewed checkout containing current main and this change. Current main already includes the operator profile files; do not replay operator commit946723b wholesale. Review the source patch, upstream lock reconciliation and build provenance. Adopt a new immutable image digest only after explicit review/approval; keep the unchanged requirements file.
2. Apply the patch to a clean source checkout at the exact commit:

   ```sh
   git rev-parse HEAD
   git apply --check /path/to/CollectiveUI/patches/codex/a6274249-protected-masks.patch
   git apply /path/to/CollectiveUI/patches/codex/a6274249-protected-masks.patch
   cd codex-rs
   cargo test -p codex-linux-sandbox --lib bwrap::
   ```

   Require HEAD a6274249d5877030676db098914db686bab7c921 before applying. Do not apply to a different source/version or silently upgrade.
3. Build/review the native artifact and image without live credentials. Record source/patch/lock/artifact hashes and the new image digest. The unchanged Dockerfile still installs the official npm binary; applying a source patch alone does not change that image.
4. On the already reviewed VM/profile, run both probes against that exact approved digest:

   ```sh
   PERSONAL_CODEX_DOCKER_EXECUTABLE=/usr/bin/docker \
   PERSONAL_CODEX_SANDBOX_PROFILE=collectiveui-sandbox-v1 \
   PERSONAL_CODEX_NATIVE_IMAGE=collectiveui/personal-codex@sha256:<reviewed-digest> \
   node scripts/probe-personal-codex-protected-masks.mjs
   ```

   Repeat the original node scripts/probe-personal-codex.mjs with the same approved selectors. The fixed profile module must exist, validate its protected files/hashes, and match container inspection. There is no arbitrary profile input or fallback.

The new matrix creates separate disposable home/workspace volumes for missing, empty and populated .codex. All auth/config/history/session/log/unknown-sibling contents are invalid public sentinels. It checks:

- actual native workspace write/read; protected home reads/writes/listing; metadata contents, file/directory creation, rename and removal;
- links from workspace to protected auth and an unknown home sibling; a mutable .codex symlink fails closed before its command can execute;
- /proc and /sys denial; execution through the active helper alias and that helper's readonly boundary;
- a reachable loopback listener immediately before and after native network denial; RPC errors, stderr, timeouts, missing listeners and unavailable execution cannot pass;
- unchanged backing sentinels; both volumes and native-created files after container replacement; a successful replacement native command;
- actual nonroot, readonly-root, no-capability, isolated-namespace/network container configuration with only the two fixture volumes, exact security policy; complete cleanup.

Require exit0, authenticated:false, verified:true, every named check exactly true, expected unchanged requirements hash, and recorded image IDs corresponding to the reviewed digest. A red or incomplete check blocks activation. The matrix does not prove cross-owner broker authorization, native model turns, native thread history, actual account entitlement or live proxy policy; those remain separate acceptance checks.

No login step is needed or permitted for this investigation. Once every native gate passes, the existing [activation approvals and each-person login steps](../personal-codex-vm-readiness.md#3-explicit-activation-approvals) still apply.
