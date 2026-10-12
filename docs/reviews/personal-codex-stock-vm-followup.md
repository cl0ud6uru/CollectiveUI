# Stock Codex VM qualification follow-up

The initial VM-tested implementation was PR187 head **`6fc4a44db5277d25897a904565747c60233a7af5`**. Its source, cloud evidence and artifacts are preserved. The parent reports seven exact-head CI checks passed and the official image built without Rust, with immutable local image ID **`sha256:d461285da5d72cd8e0f63f9aa53c89f4c6d3617f9158607e470eeb5f3f4d2650`**. This differs from the cloud build's ID as anticipated for installation/layer timestamps; no new image was built by this follow-up. The later approved-profile retest is recorded below separately.

The VM qualification reported both probes exiting 1 with `verified:false`. Empty/populated cases reached real stock execution and failed with `bwrap: pivot_root(/newroot): Permission denied`. Missing metadata failed before initialization and its cause remains unknown. These are parent-reported VM findings; this cloud agent did not access the VM or obtain its full raw probe logs.

## Definite diagnostic defect and bounded fix

At the tested head, the matrix drains startup stderr without saving it, continues after failed `initialize`, then suppresses the later Docker exception. A dead process can therefore become `fixtureCompleted:false` without a primary diagnostic. The code proves the reporting defect, not the missing-case root cause.

The supplemental fixture-only RPC helper captures at most 4096 bytes of stderr, removes terminal controls and redacts common credential formats. Fresh synthetic fixture volumes remain mandatory; this helper is not used in the runtime/server or production logging. It records the exact phase, Docker operation status, process exit/signal, startup stderr and transport failure. It stops initialization immediately if the process exits, protocol/version is invalid, or managed requirements fail, and refuses later requests on a dead process. Secondary replacement/setup failures retain rather than overwrite the original native failure. Both probes use it. Native acceptance remains fail closed.

Regression tests exercise a real `prepareWorkspace` error before any RPC response, bounded/redacted stderr and exit status, successful RPC, a live-process timeout, and a pivot failure. The bootstrap regression uses a nonexistent synthetic parent to cause `ENOENT`; it does not assert that the VM missing-case failure is `ENOENT` or change metadata initialization to guess at a fix. Preserve the updated missing-case phase/stderr/exit result before proposing a runtime change.

## Exact approved pivot source change

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

The parent confirmed Jason's **22:09 UTC action-time approval** for the exact one-line addition, host reload, corresponding verifier-pin update and credential-free retest: “Yeah lets get it done.” Hermes has been instructed to perform that approved operation. This agent prepared source and tests only, did not access/apply anything on the VM, and does not claim loaded-policy success or native enforcement. The prepared commits are carried forward into PR187 for the operator checkout; the original tested head remains preserved in history. The cloud has no AppArmor parser, so local parser/kernel acceptance is untested; Hermes must verify syntax against the VM's supported parser before an approved reload.

## Bounded retest through the parent

Use the preserved VM image ID above; the diagnostic scripts and host policy are outside the image, so no image rebuild is required. Two separate supplemental commits let the parent use diagnostics alone while retaining the old approved profile/pin, or the final prepared profile/pin after approval.

Diagnostics-only head: **`f9a8c58c8b0ff08510255afbb29481bd8db6ed80`**. It retains the old `d0b2…9852b` profile and verifier and can produce the missing-case diagnostic under the existing approved policy. The following commit prepares the exact one-line profile delta, its `f9f89…90d81` verifier pin and a regression rejecting old bytes. The original cloud evidence/provenance JSON and PR187 remain unchanged.

1. If diagnosing with the preserved old profile, use the diagnostics-only commit and run the unchanged full-matrix command from the [handoff](personal-codex-stock-runtime.md#credential-free-hermes-handoff-through-the-parent). Record the missing case's phase, startup stderr, process exit/signal and Docker operation status. With the old profile, both `verified:false` and the known pivot denial remain expected; do not count them as acceptance. After the approved profile/pin reconciliation, use the final PR187 head to capture any remaining missing-case failure.
2. After explicit approval only, reconcile the exact proposed profile file and verifier pin together through Hermes's operator procedure. Verify source hash and loaded profile name, parser result and fixed seccomp hash. If either source hash disagrees, the verifier must stop. Do not infer loaded policy bytes solely from its name.
3. Run both fixture probes against the same recorded image under the approved profile. Require all previously defined metadata/home/helper/process/network/persistence gates, every named check true, exit0 and `verified:true`. A new failure must retain its exact diagnostic and block activation. The proposal only addresses the audited second pivot; it does not prove downstream mounts or tools will pass.
4. Return results through the parent. Credential setup, live model/history proof, immutable registry-digest publication and deployment remain separately approved work. Preserve the tested-head evidence instead of rewriting it with new results.

## Approved-profile retest: execution works, full acceptance still false

The parent reports a VM retest of **`c4ce0da661668c4cd8a98e6171ad33d78e405e27`**, with the approved **`f9f89ce0a645d5d90b326908d384ad1c0553b71003944a9628bd5c83e4c90d81`** profile enforcing and the same **`d461285d…4d2650`** stock image. Real native workspace execution passed. The short smoke exited **0**, `verified:true`, with **10/10** checks true. The full matrix exited **1**, `verified:false`: all three missing/empty/populated cases had **20 true / 5 false** checks, with the same five failures: `metadataProtected`, `activeHelperExecution`, `defaultMetadataReadOnly`, `processIsolation`, `gitExecution`.

These are parent-reported results, not raw evidence independently inspected by this agent. Individual command replies were not retained at that head, so no failed check can yet be classified as a fixture error or enforcement failure. The original parent/child mask conflict no longer prevents the reported basic native workspace execution. That positive result does not qualify the complete security boundary, and the short smoke does not replace the full matrix.

### Source hypotheses versus unknown VM enforcement

| False check | Source finding / next discriminating evidence |
| --- | --- |
| `metadataProtected` | Likely fixture assumption: `writeFileSync(directory,…)` can produce `EISDIR`, absent from this probe's accepted-denial list. A local synthetic directory reproduced that error; the VM error remains unknown. The generic assertion discards the original code. Capture the exact failed operation and errno. `EISDIR` alone would not prove confidentiality or access denial. |
| `defaultMetadataReadOnly` | Likely fixture assumption: renaming a read-only bind-mounted metadata directory can produce `EBUSY`, absent from this probe's accepted-denial list. Capture whether the failure is that rename, a write succeeding, or a public read failing. `EBUSY` alone would not prove all metadata operations are protected. |
| `activeHelperExecution` | The current exact active arg0 directory assumption matches pinned stock source: it creates `codex-linux-sandbox` as a symlink to the current executable and adds only the active directory to readable roots. The `--help` call and `stdout.includes('sandbox')` success predicate remain unproven on this VM. Capture PATH entries, actual command, nested status/signal/spawn error/stdout/stderr. No PATH bubblewrap is introduced. |
| `processIsolation` | Stock normally creates a PID namespace and fresh procfs, but silently falls back to inherited procfs when a fresh proc mount is denied. That fallback retains PID isolation but changes what `/proc/self` reflects; it does not establish this contract's parent-access protection. Compare the public parent PID/fd/namespace fixture with the traced `/proc/self/ns/pid` result and each failed access. No namespace or proc rule is relaxed. |
| `gitExecution` | This single check combines two Git subprocesses and Python. Stock's automatic metadata protection applies to the writable root's top-level `.git`, while this probe initializes a nested temporary repository; that is a plausible positive control. Its predicate also rejects any Git stderr, including a status0 advisory. Capture each subprocess, which distinguishes a missing executable, namespace/permission failure, advisory-only rejection, and Python failure. All remain unknown until observed. |

Primary references: Linux documents [`EISDIR` when opening a directory for writing](https://man7.org/linux/man-pages/man2/open.2.html) and [`EBUSY` for an in-use directory or mount point in rename](https://man7.org/linux/man-pages/man2/rename.2.html). Pinned Codex source: [top-level metadata protection](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/protocol/src/permissions.rs#L2358), [read-only bind mounts](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/linux-sandbox/src/bwrap.rs#L1275), [arg0 symlinks](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/arg0/src/lib.rs#L344), [active helper directory selection](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/core/src/config/permissions.rs#L51), [helper readable-root injection](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/core/src/config/mod.rs#L4223), [procfs fallback](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/linux-sandbox/src/linux_run_main.rs#L422), [documented PID/proc modes](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/linux-sandbox/README.md#L91). None proves the missing VM command outcomes.

### Narrow command-evidence follow-up

The new host-side matrix records every failed native `command/exec` reply in `failedCommands.<state>[]`, preserving separate entries across checks and replacement phases. Each entry has check/phase, exact generated-command SHA-256, actual RPC error/exit code/stdout/stderr, parsed proof fields, expected proof and mismatch names. `processControls.<state>` records only the public synthetic parent PID/fd/namespace. Artifacts include the probe and diagnostics-module hashes, requirements hash and actual image IDs. Successful replies retain the original strict validator; false checks remain false.

Instrumentation observes the original script's synchronous filesystem calls and subprocess results, rethrows the same exception, and uses `uncaughtExceptionMonitor` without replacing the exception handler. Only an uncaught failure adds a `COLLECTIVE_FIXTURE_TRACE:` stderr line. It preserves the last eight filesystem operations, four subprocesses, a separate PID-namespace read and PATH entries; it records returned/thrown outcomes and underlying errno even when the original assertion throws a generic message. Successful reads record byte length and SHA-256 rather than file contents, allowing comparison with a known synthetic parent sentinel if a denial assertion fails. Nested process stdout/stderr are redacted before their 1024-character caps. Parent reply strings are redacted before 4096-character caps; structured projections are limited to depth4, 16 fields/items and 4096 characters per string. Redaction covers common credential formats, including an output-capped JSON credential field, and these helpers are exclusively for the existing disposable synthetic fixtures, never account logging. The native RPC has a separate **16384-byte** output cap; an incomplete trace is explicitly reported rather than credited as proof. JSON proof parsing and acceptance occur before diagnostic formatting, so redaction/truncation cannot turn a failure into a pass.

Regression tests check unchanged success output and failure exit status, each proof mismatch, retention of all five failures in all three states, a real synthetic `EISDIR` hidden by a generic assertion, nested subprocess status/streams, redaction before truncation, projection bounds and incomplete traces. These tests validate the diagnostic mechanism, not VM native enforcement. The five probe predicates, requirements, AppArmor/seccomp, image inputs and runtime/server remain unchanged.

### Next limited operator run through the parent

Use the exact diagnostics PR187 head supplied by the parent and the already approved/enforcing profile. Reuse the recorded VM image above after verifying that the existing tag still resolves to its complete `d461285d…4d2650` image ID. This host-side probe change requires no Rust/image build, policy reload, credential setup or deployment. This cloud agent does not contact Hermes or operate the VM.

```sh
git rev-parse HEAD
/usr/bin/docker image inspect collectiveui/personal-codex:stock-runtime --format '{{.Id}}'
PERSONAL_CODEX_DOCKER_EXECUTABLE=/usr/bin/docker \
PERSONAL_CODEX_SANDBOX_PROFILE=collectiveui-sandbox-v1 \
PERSONAL_CODEX_NATIVE_IMAGE=collectiveui/personal-codex:stock-runtime \
node scripts/probe-personal-codex-protected-masks.mjs > stock-native-command-evidence.json
# Record this command's exit status even when it is 1; preserve its complete JSON.
```

Return the exact checkout/image/policy hashes, exit status, every case boolean, `failedCommands` and `processControls`, plus `failures`/`secondaryFailures` if present. Preserve the c4 retest separately. Diagnose the five failures from their actual operations and replies before proposing any assertion/runtime/policy change. Require the unchanged full matrix's exit0, all checks true and `verified:true` for native acceptance; credentialed account proof and rollout remain separate work.

## Diagnostic result at 32f3789 and smallest source-only corrections

The parent reports the full diagnostic matrix at **`32f3789e515275dd5cbb28bf0115def5681a3f88`** still had 20/25 true in each state. The command replies resolve the earlier unknowns:

- `.codex` listing and the populated file read were denied with `EACCES`. An invalid attempt to write file contents directly to that directory returned `EISDIR`, triggering the generic assertion before meaningful child-write probes completed.
- The exact active arg0 helper returned valid help, nested status0 and empty stderr, but Node also returned a `spawnSync EPERM` error. That error correctly kept the check false.
- `.git/fixture.txt` was readable; existing/new file writes returned `EROFS`. Renaming the mounted `.git` directory returned `EBUSY`, stopping the check before `.agents`.
- `/proc/self/ns/pid` returned `ENOENT`, stopping before parent-process accesses were tested.
- Git init returned status0 and empty streams together with `spawnSync EPERM`. Git status and Python were not reached.

The parent also reports Hermes found no matching AppArmor/seccomp audit records in the reviewed time window. The outer profile permits the relevant process/readlink/socketpair calls; its seccomp returns errors without logging. These are parent-provided VM results, not newly run VM tests by this agent. Preserve the original raw 32f3789 receipt; the old cloud evidence/provenance files and all previous commits are unchanged.

### Subprocess EPERM: isolated mechanism, no security relaxation

Pinned stock [restricted-network seccomp](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/linux-sandbox/src/landlock.rs#L200) unconditionally denies `shutdown()` with `EPERM`. Node [starts closing piped child stdin via uv_shutdown](https://github.com/nodejs/node/blob/v22.23.3/src/spawn_sync.cc#L144), and [libuv invokes shutdown on that stream](https://github.com/nodejs/node/blob/v22.23.3/deps/uv/src/unix/stream.c#L651). Node retains a pipe error separately from the child's exit status, so status0 and valid output can coexist with a spawn error. This is an input-stream close failure, not evidence that Git/helper execution was forbidden.

A disposable container using the preserved cloud stock image, Node **22.23.3**, libuv **1.51.0**, zero capabilities and no network reproduced exactly that combination by installing a **shutdown-only** error filter in the synthetic Python/Node process. Default stdin: status0, valid child marker, error `EPERM`; ignored stdin: status0, same marker, error null, empty stderr. This process-local filter only tightens a disposable fixture; no host or saved policy was changed. [Actual reproduction evidence](personal-codex-stock-shutdown-evidence.json) records image/input/source hashes and both replies. It proves the mechanism in isolation; the VM syscall was not traced. The next native VM run must confirm the correction under its complete stock filter.

The small fix is `stdio: ['ignore','pipe','pipe']` for the helper help, Git init/status and Python-print commands: all are explicitly no-input fixtures. Every spawn error remains fatal even with status0. Helper output must still contain its help marker; Git must create a real `.git/HEAD`, return clean status with empty stderr, and Python must print its exact marker. Production adapters and user command handling are unchanged. General Node code that requires piped stdin can still encounter the stock restriction; this task does not claim to fix that upstream compatibility limitation.

To reproduce without building an image (cloud uses `/usr/local/bin/docker`; use the reviewed operator executable on the VM):

```sh
/usr/local/bin/docker run --rm -i --network none --cap-drop ALL \
  --security-opt no-new-privileges:true --read-only --user 10001:10001 \
  collectiveui/personal-codex:stock-runtime python3 - \
  < tests/fixtures/personal-codex/shutdown-only.py
```

### Metadata corrections retain meaningful writes and backing integrity

Only structural errors on the actual root directory are scoped exceptions: `EISDIR` for file-write/unlink on a directory, `EEXIST` for recreating it, and `EBUSY` for removing/renaming its mount root. None is credited as a permission or confidentiality proof. `.codex` must still deny listing, populated-file reading/overwriting, new-file writing and new-directory creation. Both `.git` and `.agents` must remain publicly readable while existing/new file writes are denied; `EBUSY` is accepted only for renaming their mount roots. The original independent, byte-for-byte backing sentinel/listing check remains a mandatory acceptance gate before and after replacement. A successful meaningful write or directory rename still fails immediately. The old custom-mask proof is untouched; the correction applies to the prepared stock directory representation.

### Absent procfs: independently observe the actual native PID namespace

The pinned `:minimal` [mount builder starts from an empty root](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/linux-sandbox/src/bwrap.rs#L538), whose Linux default readable roots omit `/proc`. When the fresh-proc preflight fails, [stock disables that mount](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/linux-sandbox/src/linux_run_main.rs#L422); it still [requests user and PID namespaces](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/linux-sandbox/src/bwrap.rs#L377). In this profile the fallback therefore leaves procfs absent, rather than binding the parent procfs. No new proc read grant or inherited PID mode is needed.

The process check briefly holds the exact native Node command with a random synthetic nonce. A same-UID observer in the disposable outer container matches its live command line and reads its actual `/proc/<outer-pid>/ns/pid`. Acceptance requires exactly one matched process, a live parent, parent/observer namespace equality, and a distinct native-command PID namespace. Observation errors, inherited namespace, missing/multiple matches or timeout all keep the check false. The inner command still performs every parent environ/memory/fd/cwd/root and proc-root credential access denial, tests `/sys` denial and verifies that signal0 to self is available. Existing backing-home checks remain mandatory. Native stdout proof alone cannot qualify this check: the parent combines it with the independently observed namespace result in `processObservations.<state>`.

This changes how the guarantee is measured, not the process boundary: private PID/user isolation and confidential parent data remain required. Procfs availability was an invalid positive-control assumption under this restricted stock profile. A mounted private procfs must still have a valid self namespace/status; only `ENOENT` permits the absent representation, and only with independent live namespace proof. No security policy/image/runtime inputs changed.

The local tests observe and release a real held synthetic process in the inherited namespace and explicitly reject it. This validates observation mechanics and the negative control, not a native isolated namespace in the cloud. The cloud native namespace blocker remains unchanged. Rerun the full matrix on the same VM image and approved profile, returning `processObservations` as well as failed command replies. No new host-policy approval is requested; if observation fails, preserve that exact result and keep activation blocked rather than broaden access.
