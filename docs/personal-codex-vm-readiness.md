# Minimal personal Codex VM readiness check

**Current stock route:** use the [pinned build, requirements tradeoffs, actual cloud evidence and credential-free Hermes handoff](reviews/personal-codex-stock-runtime.md). The native namespace gate remains blocked in the cloud. The earlier source-patch/planner work and VM observations below are historical evidence, not acceptance of the stock route.
Run this only on the nominated execution VM, against a reviewed checkout/image. It does not authorize deployment, real account sign-in, security changes, or live egress rules. The current CollectiveUI cloud host fails the native sandbox gate.

## 1. Read-only prerequisites

```sh
uname -s -m
node --version
test -x /usr/local/bin/docker
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/nonexistent DOCKER_CONFIG=/nonexistent /usr/local/bin/docker version --format 'server={{.Server.Version}} os={{.Server.Os}} arch={{.Server.Arch}}'
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/nonexistent DOCKER_CONFIG=/nonexistent /usr/local/bin/docker info --format 'driver={{.Driver}} cgroup={{.CgroupVersion}} cpus={{.NCPU}} memory={{.MemTotal}} security={{json .SecurityOptions}}'
```

The tested fixture path requires Linux x86_64/amd64, Node 22.18 or later, the exact Docker executable path used by the broker, and access to the intended local daemon without inherited Docker context/remote-host settings. Ensure persistent local volume storage and capacity for each runtime's configured limits (defaults: 2 CPUs, 2 GiB memory, 256 PIDs), plus host/services overhead. Version/security reports alone do not prove sandbox readiness.

## 2. Disposable native gate, before credentials or egress

Approve running this development fixture on the candidate VM: public package/image downloads, an offline fixture image build, and disposable containers/volumes on Docker `network=none`. It creates no native grant, owner enrollment, external network, proxy, firewall rule, or host security configuration.

```sh
scripts/build-personal-codex-stock.sh
node scripts/probe-personal-codex.mjs
```

Require exit **0**, `authenticated: false`, `verified: true`, and every reported check true: exact inspected sandbox policy, exact protocol, managed policy, native workspace execution, protected auth/proc reads denied, symlink read denied, reachable loopback positive control, native network denied, both volumes retained, and the native-created file retained after replacement. Also require the full stock matrix in the linked handoff to pass. A missing listener or RPC error must not count as a successful denial. The probe now tests that positive control explicitly.

If namespace creation fails, stop. Do not disable the sandbox or add privileged mode, capabilities, unconfined seccomp, or host namespaces to pass. Select/review a host supporting the same constraints. The stock image includes pinned Git/Python. These credential-free checks do not prove actual model tool execution, native thread history, authentication, or proxy enforcement.

After separate approval installs the reviewed production digest, repeat the same no-credentials probe against that image:

```sh
PERSONAL_CODEX_NATIVE_IMAGE='collectiveui/personal-codex@sha256:<reviewed-digest>' node scripts/probe-personal-codex.mjs
```

## Reviewed operator sandbox profile (optional, fail closed)

The broker accepts `"sandboxProfile": "collectiveui-sandbox-v1"` and
`"dockerExecutable": "/usr/bin/docker"` in its protected operator JSON. The
executable defaults to `/usr/local/bin/docker`; only these two absolute paths are
accepted, with no PATH lookup or inherited Docker context. Omit `sandboxProfile`
to retain Docker default confinement; this is not an automatic namespace workaround.
No arbitrary security options, profile paths or replacement hashes are accepted.

After separate host-security approval, install the exact checked-in files:

```sh
sudo install -d -o root -g root -m 0755 /etc/collectiveui/security
sudo install -o root -g root -m 0444 docker/personal-codex/collectiveui-seccomp-v1.json /etc/collectiveui/security/collectiveui-seccomp-v1.json
sudo install -o root -g root -m 0444 docker/personal-codex/collectiveui-sandbox-v1 /etc/apparmor.d/collectiveui-sandbox-v1
sudo apparmor_parser -r /etc/apparmor.d/collectiveui-sandbox-v1
```

All parents through `/` must be root-owned real directories without group/other
write permission; both files must be root-owned, regular, non-writable files
(no symlinks). The driver rechecks paths and SHA256 before creation, inspection,
retained start and bridge admission; failures retain storage and require operator
reconciliation. Compiled-in pins (also tested against repository bytes):

- Seccomp: `e077360ce81d54eb7acf5d15d20e7c9444a16c68ea50a38ac66cb8e3ccf13370`
- AppArmor source: `d0b2b0d205f15ed22d05bfe0e21a64947cab9ddff933652bfd22caab1789852b`

These policies derive from Moby defaults with nested unprivileged namespace
`clone`, `unshare`, `setns`, `mount`, `umount2`, `pivot_root` allowances and AppArmor
`mount`/`userns` permission. `clone3` retains the default ENOSYS fallback. This
expands kernel attack surface: it grants **no outer capabilities** and is only
admitted with cap-drop ALL, non-root user, no-new-privileges, exact mounts/network
and all existing limits. Do not apply it to unrelated/browser runtimes.

Docker inspect records the seccomp JSON, not the CLI filename. Admission requires
exact ordered SecurityOpt (`no-new-privileges:true`, named AppArmor, compact pinned
seccomp JSON) and exact `AppArmorProfile`; unconfined, missing or extra entries
are rejected. A root administrator remains trusted: source hashing cannot attest
the kernel's compiled AppArmor policy, and root can replace/reload profiles or race
checks. Operators must load these exact bytes and not redefine the same profile
name; no protection against a compromised root/Docker daemon is claimed.

Repeat the no-credentials gate using the **same** shared verifier and profile:

```sh
PERSONAL_CODEX_DOCKER_EXECUTABLE=/usr/bin/docker \
PERSONAL_CODEX_SANDBOX_PROFILE=collectiveui-sandbox-v1 \
PERSONAL_CODEX_NATIVE_IMAGE='collectiveui/personal-codex@sha256:<reviewed-digest>' \
node scripts/probe-personal-codex.mjs
```

These are explicit fixed selections, not general security-opt environment
options. The probe's native command, protected/symlink reads, network positive
control and replacement storage checks remain mandatory; each named check must
be exactly true. No sign-in or real credential is used.

## Home VM evidence (2026-10-12)

On `10.1.31.136`, scoped policy `collectiveui-sandbox-v1` permits the pinned
bubblewrap namespace operations without host-wide AppArmor changes or outer
capabilities. Chromium 154.0.8037.92 / Playwright 1.63.0 passed the actual
production BrowserRuntime DOM, title, button, and intercepted-egress checks with
`chromiumSandbox: true`, network none, a read-only root, cap-drop ALL, and the
scoped policies. This is a deterministic synthetic-page launch proof, not a live
owner/viewer/authentication proof.

Codex 0.163.0-alpha.2 remains **blocked**. Its exact production image passed
protocol, managed-policy, pinned-container-policy and replacement-storage checks,
but native workspace execution failed while masking the missing workspace
`.codex` directory. A diagnostic pre-existing directory got beyond that error
and exposed an overlapping-denial failure masking `/codex-home/auth.json` inside
the denied auth home. No protected-read or network enforcement success is claimed;
those assertions were not reached. Do not remove the auth-home or metadata denials
to activate it. A separately reviewed managed-filesystem compatibility fix and a
fully green no-credentials probe are still required.

The seccomp profile permits `chroot` for Chromium's nested user-namespace sandbox;
outer containers retain no capabilities. AppArmor permits bubblewrap's observed
pivot only from `/tmp/oldroot/` to `/tmp/`. Host global restriction stays enabled.

## 3. Explicit activation approvals

1. **Host/image/service:** name the VM and exact production image digest; approve installing the broker, applying foundation migration 0054 and Codex migration 0055, and protected web/worker Unix IPC access. Socket directory 0750 without group write/other access, socket 0660, markers 0600. Admit only Jason's and his boss's exact CollectiveUI owner IDs.
2. **Storage:** approve independent owner-labelled local home/workspace volumes, backups and retention/offboarding. Agents receive only their own mounts; no Docker/broker socket or other owner's credentials. Bot deletion does not remove volumes.
3. **Network:** approve each owner's dedicated proxy and reviewed TLS allowlist/uplink. ICC stays disabled; install only the separately reviewed runtime-to-own-proxy TCP 3128 forwarding exception and established return traffic. Verify alias/native-auth reachability while other peers, host services and destinations remain denied. The broker installs none of these rules.
4. **Personal access:** enable policy for the intended people/plans/workspaces. Each person starts Settings → Connected accounts → Connect ChatGPT for Codex, enters their own OpenAI device code, signs into their own account matching their current CollectiveUI email/UPN, and confirms it. CollectiveUI login and Hermes grants remain separate.
5. **Live acceptance:** separately approve harmless native file/command, Stop, same-thread follow-up, container restart/replacement/history retention, and cross-owner isolation tests for both callers. Actual model access must succeed under their own subscriptions before release.

The broker's connect probe remains mandatory. Positive approval of dangerous/escalated commands, network expansion, and central Hermes grant sharing are outside this pilot. See [execution and authentication contracts](codex-harness.md).

The [stock-runtime handoff](reviews/personal-codex-stock-runtime.md) now proposes the official prebuilt binary and a restricted read allowlist. The [earlier native source-patch investigation](reviews/personal-codex-protected-masks.md) remains historical; its tests are not stock acceptance. Passing ordinary shell execution does not prove metadata, helper or parent-process protection.
