# Stock Codex VM qualification follow-up

The VM-tested implementation remains PR187 head **`6fc4a44db5277d25897a904565747c60233a7af5`**. Its source, cloud evidence and artifacts are preserved. The parent reports seven exact-head CI checks passed and the official image built without Rust, with immutable local image ID **`sha256:d461285da5d72cd8e0f63f9aa53c89f4c6d3617f9158607e470eeb5f3f4d2650`**. This differs from the cloud build's ID as anticipated for installation/layer timestamps; no new image was built by this follow-up.

The VM qualification reported both probes exiting 1 with `verified:false`. Empty/populated cases reached real stock execution and failed with `bwrap: pivot_root(/newroot): Permission denied`. Missing metadata failed before initialization and its cause remains unknown. These are parent-reported VM findings; this cloud agent did not access the VM or obtain its full raw probe logs.

## Definite diagnostic defect and bounded fix

At the tested head, the matrix drains startup stderr without saving it, continues after failed `initialize`, then suppresses the later Docker exception. A dead process can therefore become `fixtureCompleted:false` without a primary diagnostic. The code proves the reporting defect, not the missing-case root cause.

The supplemental fixture-only RPC helper captures at most 4096 bytes of stderr, removes terminal controls and redacts common credential formats. Fresh synthetic fixture volumes remain mandatory; this helper is not used in the runtime/server or production logging. It records the exact phase, Docker operation status, process exit/signal, startup stderr and transport failure. It stops initialization immediately if the process exits, protocol/version is invalid, or managed requirements fail, and refuses later requests on a dead process. Secondary replacement/setup failures retain rather than overwrite the original native failure. Both probes use it. Native acceptance remains fail closed.

Regression tests exercise a real `prepareWorkspace` error before any RPC response, bounded/redacted stderr and exit status, successful RPC, a live-process timeout, and a pivot failure. The bootstrap regression uses a nonexistent synthetic parent to cause `ENOENT`; it does not assert that the VM missing-case failure is `ENOENT` or change metadata initialization to guess at a fix. Preserve the updated missing-case phase/stderr/exit result before proposing a runtime change.

## Exact pivot proposal, pending approval

Hermes's read-only audit supplied through the parent:

```text
AppArmor DENIED operation=pivotroot class=mount
profile=collectiveui-sandbox-v1 name=/newroot/ srcname=/newroot/
```

Pinned stock source [bubblewrap.c](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/vendor/bubblewrap/bubblewrap.c#L3064) sets `base_path=/tmp`, mounts a private tmpfs and performs `pivot_root(base_path,"oldroot")` at line3370. Later it changes cwd to `/newroot` and calls `pivot_root(".",".")` at [line3459](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/vendor/bubblewrap/bubblewrap.c#L3459). This explains why the old first-pivot allowance must remain and why the second one needs both exact paths. AppArmor supports constraining both the new root and old-root placement in its [pivot rule grammar](https://manpages.debian.org/bookworm/apparmor/apparmor.d.5.en.html#PIVOT_ROOT_RULE).

The minimal proposed permission delta is exactly one addition:

```diff
   pivot_root oldroot=/tmp/oldroot/ /tmp/,
+  pivot_root oldroot=/newroot/ /newroot/,
```

The original complete profile SHA-256 is **`d0b2b0d205f15ed22d05bfe0e21a64947cab9ddff933652bfd22caab1789852b`**. Adding that line with the existing indentation/newline produces exactly Hermes's candidate SHA-256 **`f9f89ce0a645d5d90b326908d384ad1c0553b71003944a9628bd5c83e4c90d81`**. The corresponding source verifier pin must change to this exact value in the same reviewed change. Old profile bytes must then be rejected. Seccomp SHA-256 **`e077360ce81d54eb7acf5d15d20e7c9444a16c68ea50a38ac66cb8e3ccf13370`**, capabilities, mount/network/namespace options and all other profile rules stay unchanged. No broad `pivot_root`, wildcard path, unconfined mode, PATH helper or Rust rebuild is proposed.

The supplemental branch prepares the source change for review; it does not install/reload anything. The parent is obtaining **action-time host apply/reload and verifier-pin approval**. Do not treat repository source preparation as that approval. No host profile was applied by this agent, and no loaded-policy success or native enforcement is claimed. The cloud has no AppArmor parser, so local parser/kernel acceptance is untested; Hermes must verify syntax against the VM's supported parser before an approved reload.

## Bounded retest through the parent

Use the preserved VM image ID above; the diagnostic scripts and host policy are outside the image, so no image rebuild is required. Two separate supplemental commits let the parent use diagnostics alone while retaining the old approved profile/pin, or the final prepared profile/pin after approval.

1. On the diagnostics-only commit, keep the existing approved profile and run the unchanged full-matrix command from the [handoff](personal-codex-stock-runtime.md#credential-free-hermes-handoff-through-the-parent). Record the missing case's phase, startup stderr, process exit/signal and Docker operation status. Both `verified:false` and the known pivot denial remain expected until approval; do not count them as acceptance.
2. After explicit approval only, reconcile the exact proposed profile file and verifier pin together through Hermes's operator procedure. Verify source hash and loaded profile name, parser result and fixed seccomp hash. If either source hash disagrees, the verifier must stop. Do not infer loaded policy bytes solely from its name.
3. Run both fixture probes against the same recorded image under the approved profile. Require all previously defined metadata/home/helper/process/network/persistence gates, every named check true, exit0 and `verified:true`. A new failure must retain its exact diagnostic and block activation. The proposal only addresses the audited second pivot; it does not prove downstream mounts or tools will pass.
4. Return results through the parent. Credential setup, live model/history proof, immutable registry-digest publication and deployment remain separately approved work. Preserve the tested-head evidence instead of rewriting it with new results.
