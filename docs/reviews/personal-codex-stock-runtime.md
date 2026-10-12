# Stock personal Codex runtime

This route uses the **official prebuilt Codex 0.163.0-alpha.2 app-server** in CollectiveUI's existing per-user Docker containers. It starts from main `c7245025b486b91d33ffbc10358296ebf896da3e`. PR186 and its `9b9e57c35dbc2321f07731523b5868665ea1cadc` branch are preserved. No Rust build, Kubernetes migration, host policy change, real login, merge or deployment is included.

**Native acceptance remains blocked in the cloud.** The actual stock `command/exec` returns exit 1 with `bwrap: No permissions to create a new namespace`. The [credential-free evidence](personal-codex-stock-evidence.json) has `authenticated: false` and `verified: false`. The prior Rust planner tests/custom binary are not evidence for this route.

## Configuration and requirements contract

The adapted pattern comes from [OpenClaw Enterprise's TypeScript profile patch](https://github.com/openclaw/openclaw-enterprise/blob/07590c64e27ac61c9ad60d9ab61424b70281011a/deploy/runtime/openclaw-codex-read-only-paths.patch): named permissions, `:minimal` read, writable projects, and literal read-only runtime/helper grants. CollectiveUI retains its own paths, disabled tool network, fixed managed requirements, owner enrollment, loopback listener, broker transport and two persistent private volumes. OpenClaw's auth bindings, Kubernetes driver, gateway and OpenShell are not transplanted.

The managed configuration representation changes explicitly:

| Existing intent | Stock representation and acceptance requirement |
| --- | --- |
| Tools cannot read native credentials, history or unrelated home data | Replace `/ = read` and the physical `/codex-home = deny` parent mask with `:minimal = read`, `/opt/codex` and `/opt/collective-codex` read grants. Keep exact auth/config/session/history/log denies. Ungranted home siblings default to deny and are absent from the filesystem view. Test direct reads and workspace symlinks to both credentials and an unknown sibling. |
| The active native helper must work without exposing the home | Stock [config](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/core/src/config/mod.rs#L4223) adds only its active `tmp/arg0/codex-arg0*` directory as read-only. Removing the parent mask avoids hiding that narrow grant. Test execution through that exact alias, denied writes to it, and continued auth denial. |
| Workspace `.codex` is confidential and immutable to tools | Keep its explicit **deny**, including populated contents. Before starting app-server, materialize a missing `.codex` as an empty persistent directory. Refuse a symlink or non-directory. Existing directory contents and permissions are retained. This avoids the missing-directory/empty-file mask mismatch; successful double-mount enforcement for empty/populated metadata still requires the VM proof. `.git` and `.agents` retain stock read-only metadata protection and have separate read/write tests. |
| Tools cannot access the parent executor's processes or use proc links to escape | Stock's default isolated PID/user namespace remains mandatory. Fresh private procfs may be readable; with `:minimal`, the stock no-proc fallback omits `/proc` entirely. The fixture independently observes the exact live native command from outside and requires its PID namespace to differ from the live parent executor's namespace. Native parent environ/memory/fd/cwd/root and proc-root credential reads must still be denied, and backing sentinels must remain intact. Missing proc paths alone cannot pass. Inherited PID mode is never enabled; `/sys` stays denied. |
| Tools cannot mutate the backing auth home | Known secret writes must fail. For otherwise ungranted paths, stock's empty filesystem may permit a **discarded private shadow write**; that is not permission to change the real volume. The gate performs the shadow attempt, then separately reads every parent-side sentinel and requires unchanged contents before and after replacement. Synthetic helper ancestors can be listed; the original home listing and unknown siblings remain hidden. This deliberately does not promise an errno on every arbitrary path or denial of listing a synthetic directory. |
| Tool networking is denied independently of proxy variables | `network.enabled = false` remains unchanged. Reachable TCP, UDP and filesystem Unix-socket services are positive controls outside the tool sandbox. The same probes, with proxy variables cleared, must all fail inside real native `command/exec`, with successful execution and an exact proof marker. A timeout or unavailable sandbox never passes. |

The scope is confidentiality of real home data, backing-data integrity, metadata protection, parent-process isolation and denied tool networking. The changed representation is not yet asserted to enforce that contract on the execution VM: every native gate must pass there before rollout. The driver continues to reject unexpected mounts, privileges, capabilities, namespaces, environment, image, peers and policies. The broker's lightweight pre-login probe now tests credential access through `/proc/1/root` rather than assuming all of private procfs is unreadable; it does not replace the full acceptance matrix.

## Pinned build and artifact

Run `scripts/build-personal-codex-stock.sh` on Linux amd64 with Node, curl and the selected absolute Docker executable. The script downloads only public inputs from [the lock](../../docker/personal-codex/stock-inputs.lock.json), checks every SHA-256 outside and inside Docker, and builds with **`--network=none`**. Git/Python and all 39 added Debian dependency packages are version-, URL- and hash-pinned. Package availability can change; missing inputs fail closed. The script clears Docker context/host/config environment and uses a temporary Docker config. The base image may need to be preloaded on an offline operator host.

The official platform package is extracted intact to `/opt/codex`, with its resource layout preserved. `/usr/local/bin/codex` points directly to its unmodified binary. No PATH bubblewrap is installed. Stock Codex may warn about missing PATH bubblewrap, then uses its bundled resource; its measured hash is required by the probe.

| Artifact | SHA-256 / identity |
| --- | --- |
| Official source | `a6274249d5877030676db098914db686bab7c921` |
| Official Linux x64 npm tarball | `ab47cfba65f596acaac865e779532fccd422b5928f375ae36bc1b997b75ce49a` |
| Unmodified native binary | `68374c44c942514b480b21a14f666d75922633594c652f3a2052e3eca80ea947` |
| Bundled bubblewrap | `77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c` |
| Managed requirements | `cd789bc4cc3345ac488fafd47b68034342da5f2ad8cb9fac08600b0448d5d768` |
| Built local image ID | `sha256:087feda902028b7713d70f4187a4e6d5094fa620d2c7dc44e27649485e1aac71` |
| Exported Docker archive | `6680e3d7bb4b409d8771391534cc381f45166d17aec1db308f954d4df87b0ae6` |

The archive is `/workspace/artifacts/collectiveui-personal-codex-stock-runtime.tar`, with a checksum sidecar. It preserves the exact tested image; it is not published and the local image ID is **not a registry manifest digest**. The lock makes the build inputs reproducible; independent clean builds may produce different image IDs because package installation/layer timestamps vary. Record the resulting ID on each build. [Provenance](personal-codex-stock-provenance.json) includes the npm-published SLSA statement tying this exact package to the source commit and release workflow. Its subject digest matches the downloaded package; Sigstore signatures were not independently verified.

## What was exercised

The production image built offline, reports `codex-cli 0.163.0-alpha.2`, and runs the real stock app-server. Missing, empty and populated `.codex` fixtures each passed protocol, managed policy, requirements hash, native/bubblewrap hash, the disposable container boundary, and reachable TCP/UDP/Unix-socket positive controls. Original backing sentinels and both private volumes survived container replacement. Every fixture resource was cleaned up. These fixture checks do not attest production network/AppArmor admission: the cloud daemon lacks AppArmor, and the unchanged production driver would reject that default host.

In all three cases the first real native workspace command reached bundled bubblewrap and failed at namespace creation. No workspace/helper/Git/Python command, protected read or write, metadata enforcement, parent-process isolation, denied network bypass, native-created file persistence or native tool turn is credited. The bootstrap unit tests validate preparation only. Source inspection suggests the home overlap is removed; it does not prove the remaining metadata mounts work.

Focused tests: 110 passed across nine personal Codex/worker/harness suites. Typecheck and focused lint pass after restoring dependencies with the repository lockfile. No real account, entitlement, model authentication, live proxy or thread-history continuation was tested.

## Credential-free Hermes handoff through the parent

The parent must hand this plan to Hermes after the appropriate VM fixture approval. This document does not authorize contacting Hermes, mutating the VM, installing a host profile, provisioning credentials or deploying the broker.

1. Review this branch/PR and the requirements changes above. Use the existing nominated VM and already installed, hash-verified `collectiveui-sandbox-v1` profile. If the profile is missing or mismatched, stop and request the separate host-security approval; do not edit it to get a pass.
2. After approved artifact transfer, verify the archive hash, load it, and check the image ID. Alternatively run the pinned build script there and record its new local image ID. No registry publication or production enrollment is required for a disposable fixture.

   ```sh
   sha256sum collectiveui-personal-codex-stock-runtime.tar
   # Require 6680e3d7bb4b409d8771391534cc381f45166d17aec1db308f954d4df87b0ae6
   docker load -i collectiveui-personal-codex-stock-runtime.tar
   docker image inspect collectiveui/personal-codex:stock-runtime --format '{{.Id}}'
   # Require sha256:087feda902028b7713d70f4187a4e6d5094fa620d2c7dc44e27649485e1aac71 for the archive.
   ```

3. From that reviewed checkout, run the full matrix and short smoke without accounts or credentials:

   ```sh
   PERSONAL_CODEX_DOCKER_EXECUTABLE=/usr/bin/docker \
   PERSONAL_CODEX_SANDBOX_PROFILE=collectiveui-sandbox-v1 \
   PERSONAL_CODEX_NATIVE_IMAGE=collectiveui/personal-codex:stock-runtime \
   node scripts/probe-personal-codex-protected-masks.mjs > stock-native-evidence.json

   PERSONAL_CODEX_DOCKER_EXECUTABLE=/usr/bin/docker \
   PERSONAL_CODEX_SANDBOX_PROFILE=collectiveui-sandbox-v1 \
   PERSONAL_CODEX_NATIVE_IMAGE=collectiveui/personal-codex:stock-runtime \
   node scripts/probe-personal-codex.mjs > stock-smoke-evidence.json
   ```

   Require both exits **0**, `authenticated: false`, `verified: true`, every named check exactly true, exact requirements hash and the reviewed image ID. The full matrix covers writable workspace, exact active helper/read-only alias, Git/Python, direct and symlink home reads, credential writes, private shadow/parent sentinel integrity, confidential `.codex`, read-only `.git`/`.agents`, PID/proc isolation, TCP/UDP/Unix-socket controls and denied bypass, container replacement and native file persistence. A mutable metadata symlink must prevent its command from running. No error, stderr, timeout or missing listener can count as a denial.
4. If namespaces fail, stop. If metadata or helper mounts fail after namespace creation, preserve the exact synthetic diagnostic and false check; do not remove the deny, add PATH bubblewrap, enable full access, change host security, or rebuild Codex. Return the evidence to the parent for a bounded follow-up.
5. Only after native acceptance and explicit rollout approval: publish/review an immutable **registry digest** accepted by the existing driver; review per-owner proxy reachability/firewall isolation and same-owner recovery; install/enroll only approved owner IDs. Credential setup and each user's own sign-in remain separate approvals under [the existing activation contract](../personal-codex-vm-readiness.md#3-explicit-activation-approvals). Real tool turns and history continuity still require authorized account testing. Do not merge/deploy as part of this task.
