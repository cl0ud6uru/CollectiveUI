# Stock Codex SIWC validation record

This record is for the bounded SIWC adapter only. It does not authorize activation. `BrokerConfig.siwcSandboxVerified` defaults to `false`; leave it false until an operator reruns the protected stock proof on the actual runtime host and obtains the required real sandbox evidence.

## Local artifact

Built locally with `bash scripts/build-personal-codex-stock.sh`. The build uses the exact published `@openai/codex` 0.163.0-alpha.2 Linux artifact and validates its SHA-256 from `docker/personal-codex/stock-inputs.lock.json`; it does not rebuild Rust or publish the image.

- Image: `collectiveui/personal-codex:stock-runtime`
- Local immutable image ID after the final config change: `sha256:473c0b7fc3eb558f6f99c560ab6dbdc0ff418d282f9eb60a83cfd77f55de190d`
- Stock Codex binary SHA-256: `68374c44c942514b480b21a14f666d75922633594c652f3a2052e3eca80ea947`
- Published artifact archive SHA-256: `ab47cfba65f596acaac865e779532fccd422b5928f375ae36bc1b997b75ce49a`

## Disposable IPC and provider configuration check

A temporary network-none container using that image was started with private temporary volumes, read-only root, dropped capabilities, and UID/GID 10001. A synthetic-only credential (`fixture-only-siwc-sentinel`) was sent over stdin using:

```sh
printf '%s' '{"accessToken":"fixture-only-siwc-sentinel","credentialBinding":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' \
  | docker exec -i "$container" node /opt/collective-codex/server.mjs --sync-token
```

The command exited 0. A credential-free `/proc/*/environ` scan in the same container found the sentinel in the app-server child environment (positive control); it printed only `appserver_sentinel_present`, not the token. `--clear-token` then exited 0, restarted the child, and a second scan printed `sentinel_cleared` with no matching process. The container and temporary volumes were removed.

With a synthetic token synchronized, stock app-server `initialize`, `config/read`, and `configRequirements/read` returned these effective fields:

```text
model_provider=openai_chatgpt_plan
provider.name=ChatGPT plan
provider.base_url=https://api.openai.com/v1
provider.env_key=ACCESS_TOKEN
provider.wire_api=responses
provider.requires_openai_auth=false
provider.supports_websockets=false
forced_login_method=null
shell_environment_policy.inherit=none
shell_environment_policy.filters.ACCESS_TOKEN=exclude
```

The initial runtime inspection showed the shell policy was not effective when set only in requirements TOML. The wrapper now pins those two values as immutable app-server `-c` arguments, and this record reflects the rebuilt image above. This config read establishes the effective settings, not successful sandbox enforcement.

## Runtime-host follow-up and required rerun

The full protected stock proof was attempted against the exact pinned binary. Native workspace execution failed before the SIWC shell and parent-process checks because bundled bubblewrap reported:

```text
bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces
```

No host sysctl, AppArmor, seccomp, or security setting was changed. That local environment did not prove shell child environment exclusion or `/proc` isolation, and SIWC remains unavailable by default. Do not treat the config values or the synthetic parent-process fixture as that proof.

The parent subsequently reports a disposable stock-runtime run at **`d32db5c0`** on the VM: stock build, app-server sentinel positive control, agent shell exclusion, parent `/proc` isolation, SIWC socket denial and token clearing passed. Two helper checks failed because the probe used `process.env.PATH.split(...)` while the required command environment inherits nothing. The child environment check exited zero without observation output, so it remains inconclusive. These are parent-reported results, not raw evidence independently inspected on this Mac.

The parent reports the corrected run at **`c5cd2e33f54826997f7da3390419d52a8aa23311`** passed all **78/78** protected-mask checks across the three fixtures with exit zero. The SIWC proof passed **13/14** checks, with exit one: the child spawn failed before producing a PID, exit code or exact JSON. The command environment, app-server sentinel, parent `/proc`, socket, token-clear/restart and cleanup controls passed. This is a child-invocation failure, not evidence of token leakage. The recorded unchanged VM image is **`sha256:28dd9f29a1bedb857b980c754bcce4ab0927ec0d8345f08e58ff63d0b662b8de`**; its requirements hash is **`745a4740a6092ac7ffdfd4d2c9e2f16a86cdc718042eb112d864d749a5d0be09`**, also confirmed from this checkout.

The next probe pins both the parent command and child executable to the reviewed image's `/usr/local/bin/node`. [Node's executable discovery](https://github.com/nodejs/node/blob/v22.22.0/src/env.cc#L715) falls back to `argv[0]` when [libuv cannot read `/proc/self/exe`](https://github.com/nodejs/node/blob/v22.22.0/deps/uv/src/unix/procfs-exepath.c#L26). With the stock no-proc fallback and no inherited PATH, `process.execPath` can therefore be the basename `node`, which does not find `/usr/local/bin/node` in the default child search path. A local synthetic no-PATH run reproduced `ENOENT` for the basename and successful PID JSON for the absolute executable. This establishes the probe assumption failure; the VM's exact spawn diagnostic and the corrected VM run remain required. The corrected probe retains bounded credential-free spawn details and still rejects every spawn error or missing observation. It does not add PATH, alter child environment inheritance, modify the image or change security policy.

The corrected stock helper probes discover the sole prepared `codex-arg0` directory in the sandbox's synthetic helper tree and require its alias to resolve to `/opt/codex/bin/codex`. They do not inherit or inject PATH. Both runtime probes accept a complete immutable local `sha256:` image ID as well as the reviewed repository name, and still verify runtime artifacts and security constraints. The SIWC probe uses the normal private supervisor socket and app-server bridge. Its child must emit an exact nonce/PID/environment observation; empty output, stderr, a signal, or any spawn error fails even with exit zero. It checks exclusion in the command and child, independently observes the token-bearing app-server, denies parent-environment and socket access, then confirms app-server replacement and absence of the sentinel after clearing.

Run from the final reviewed PR #205 checkout on the actual runtime host. These portal/probe corrections do not change the wrapper image, pinned Codex binary, requirements, AppArmor or seccomp; reuse the existing reviewed VM image. A VM image can have a different config ID from the local record above. Capture the existing tag's complete ID, compare it with the operator's recorded approved image, and use that same ID in both proofs and the broker configuration. The parent coordinates this run; the Mac task does not operate the VM.

```sh
set -eu
git rev-parse HEAD
sha256sum /etc/apparmor.d/collectiveui-sandbox-v1 \
  /etc/collectiveui/security/collectiveui-seccomp-v1.json \
  docker/personal-codex/requirements.toml
runtime_image="$(/usr/bin/docker image inspect collectiveui/personal-codex:stock-runtime --format '{{.Id}}')"
printf 'Runtime image: %s\n' "$runtime_image"
test "$runtime_image" = sha256:28dd9f29a1bedb857b980c754bcce4ab0927ec0d8345f08e58ff63d0b662b8de
export PERSONAL_CODEX_DOCKER_EXECUTABLE=/usr/bin/docker
export PERSONAL_CODEX_SANDBOX_PROFILE=collectiveui-sandbox-v1
export PERSONAL_CODEX_NATIVE_IMAGE="$runtime_image"

# Preserve complete evidence and exit codes even if either proof fails.
mask_exit=0
node scripts/probe-personal-codex-protected-masks.mjs > stock-native-evidence.json || mask_exit=$?
siwc_exit=0
node scripts/probe-personal-codex-siwc.mjs > stock-siwc-evidence.json || siwc_exit=$?
printf 'Protected masks exit: %s; SIWC exit: %s\n' "$mask_exit" "$siwc_exit"
test "$mask_exit" -eq 0
test "$siwc_exit" -eq 0

node --input-type=module - <<'JS'
import { readFileSync } from 'node:fs';
import { allStockChecksPass } from './scripts/lib/personal-codex-stock-proof.mjs';
const masks = JSON.parse(readFileSync('stock-native-evidence.json', 'utf8'));
const siwc = JSON.parse(readFileSync('stock-siwc-evidence.json', 'utf8'));
if (masks.authenticated !== false || masks.verified !== true || !allStockChecksPass(masks.cases)
  || siwc.authenticated !== false || siwc.verified !== true
  || Object.values(siwc.checks).some(value => value !== true)) process.exit(1);
console.log('Both disposable stock proofs passed; retain complete JSON for review.');
JS
```

Return the exact checkout/image/policy hashes, both exit codes, every check, the child observation, and complete failure diagnostics. Do not set `siwcSandboxVerified=true` unless both the full protected-mask proof and the token-bearing process proof pass on that host. The probes create and remove only their own temporary containers and volumes, use a synthetic sentinel, and do not change Docker networking, allowlists, host security or production credentials.

## Rollout and rollback

Deploy the final reviewed feature commit and rebuild/select its immutable wrapper image, without changing Codex source. Configure the stable installation host ID, preserve existing per-user enrollment and egress isolation, and leave the SIWC runtime gate false until the checks above pass. Then the user performs local sign-in, explicit secure transfer and owner-bound import as described in `docs/connections.md`. Validate native tool use and a stock turn, refresh/resume and sign-out on the same account; never report those authenticated checks as complete from these synthetic tests.

Before rolling back to `e71527c5f065cb7d8ccc3891a03ebe4a9ba36ce3`, disable ChatGPT model access and stop/clear the new token-bearing app-server processes. Keep `siwcSandboxVerified=false`. Quarantine retained SIWC credential rows as `needs_reauth` before starting the old code (or remove them through the normal disconnect controls), without decrypting or exporting their tokens. The old code ignores SIWC metadata and must never receive an active new credential to send to its private Codex transport. Keep each user's protected local client registration for explicit reauthorization and import when rolling forward again. Retained workspace volumes and histories stay in place; do not reconnect a different account to them implicitly.
