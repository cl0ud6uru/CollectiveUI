# Minimal personal Codex VM readiness check

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
scripts/build-personal-codex-fixture.sh
node scripts/probe-personal-codex.mjs
```

Require exit **0**, `authenticated: false`, `verified: true`, and every reported check true: exact protocol, managed policy, native workspace execution, protected auth/proc reads denied, symlink read denied, reachable loopback positive control, native network denied, both volumes retained, and the native-created file retained after replacement. A missing listener or RPC error must not count as a successful denial. The probe now tests that positive control explicitly.

If namespace creation fails, stop. Do not disable the sandbox or add privileged mode, capabilities, unconfined seccomp, or host namespaces to pass. Select/review a host supporting the same constraints. The fixture omits production git/python tooling and does not prove actual model tool execution, native thread history, authentication, or proxy enforcement.

After separate approval installs the reviewed production digest, repeat the same no-credentials probe against that image:

```sh
PERSONAL_CODEX_NATIVE_IMAGE='collectiveui/personal-codex@sha256:<reviewed-digest>' node scripts/probe-personal-codex.mjs
```

## 3. Explicit activation approvals

1. **Host/image/service:** name the VM and exact production image digest; approve installing the broker, applying foundation migration 0054 and Codex migration 0055, and protected web/worker Unix IPC access. Socket directory 0750 without group write/other access, socket 0660, markers 0600. Admit only Jason's and his boss's exact CollectiveUI owner IDs.
2. **Storage:** approve independent owner-labelled local home/workspace volumes, backups and retention/offboarding. Agents receive only their own mounts; no Docker/broker socket or other owner's credentials. Bot deletion does not remove volumes.
3. **Network:** approve each owner's dedicated proxy and reviewed TLS allowlist/uplink. ICC stays disabled; install only the separately reviewed runtime-to-own-proxy TCP 3128 forwarding exception and established return traffic. Verify alias/native-auth reachability while other peers, host services and destinations remain denied. The broker installs none of these rules.
4. **Personal access:** enable policy for the intended people/plans/workspaces. Each person starts Settings → Connected accounts → Connect ChatGPT for Codex, enters their own OpenAI device code, signs into their own account matching their current CollectiveUI email/UPN, and confirms it. CollectiveUI login and Hermes grants remain separate.
5. **Live acceptance:** separately approve harmless native file/command, Stop, same-thread follow-up, container restart/replacement/history retention, and cross-owner isolation tests for both callers. Actual model access must succeed under their own subscriptions before release.

The broker's connect probe remains mandatory. Positive approval of dangerous/escalated commands, network expansion, and central Hermes grant sharing are outside this pilot. See [execution and authentication contracts](codex-harness.md).
