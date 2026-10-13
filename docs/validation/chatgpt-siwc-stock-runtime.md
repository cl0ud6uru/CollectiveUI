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

## Still required on the runtime host

The full protected stock proof was attempted against the exact pinned binary. Native workspace execution failed before the SIWC shell and parent-process checks because bundled bubblewrap reported:

```text
bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces
```

No host sysctl, AppArmor, seccomp, or security setting was changed. The shell child environment exclusion and `/proc` isolation have therefore **not** been proven in this environment, and SIWC remains unavailable by default. Do not treat the config values or the synthetic parent-process fixture as that proof.

On the actual runtime VM, build from the final reviewed source commit and capture the build's returned immutable image ID. A VM rebuild can have a different config ID; the cloud-local ID above exists elsewhere only if that exact image is transferred. Pin the published binary/archive checksums above, and use the same locally built image ID in both the proof and broker configuration:

```sh
PERSONAL_CODEX_NATIVE_IMAGE=sha256:<immutable-ID-returned-by-the-VM-build> \
  node scripts/probe-personal-codex-protected-masks.mjs
```

The VM operator must additionally perform a synthetic-sentinel run through the normal wrapper `--sync-token` and app-server `command/exec` path: verify the sentinel is present in the app-server positive-control process; verify the command process and its spawned child do not have `ACCESS_TOKEN`; verify the sandbox cannot read the app-server `/proc/<pid>/environ` or connect to `/codex-home/.collective-codex-siwc.sock`; then issue `--clear-token` and verify the sentinel is absent after restart. Do not set `siwcSandboxVerified=true` unless both the full protected-mask proof and this token-bearing process proof pass on that host. No command here changes Docker networking, allowlists, host security, or production credentials.

## Rollout and rollback

Deploy the final reviewed feature commit and rebuild/select its immutable wrapper image, without changing Codex source. Configure the stable installation host ID, preserve existing per-user enrollment and egress isolation, and leave the SIWC runtime gate false until the checks above pass. Then the user performs local sign-in, explicit secure transfer and owner-bound import as described in `docs/connections.md`. Validate native tool use and a stock turn, refresh/resume and sign-out on the same account; never report those authenticated checks as complete from these synthetic tests.

Before rolling back to `e71527c5f065cb7d8ccc3891a03ebe4a9ba36ce3`, disable ChatGPT model access and stop/clear the new token-bearing app-server processes. Keep `siwcSandboxVerified=false`. Quarantine retained SIWC credential rows as `needs_reauth` before starting the old code (or remove them through the normal disconnect controls), without decrypting or exporting their tokens. The old code ignores SIWC metadata and must never receive an active new credential to send to its private Codex transport. Keep each user's protected local client registration for explicit reauthorization and import when rolling forward again. Retained workspace volumes and histories stay in place; do not reconnect a different account to them implicitly.
