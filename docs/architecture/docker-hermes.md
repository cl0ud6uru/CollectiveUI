# Personal Docker Hermes

Personal Hermes is opt-in: first **Enable Hermes** creates one isolated Docker runtime for an enrolled CollectiveUI user, then pairs its native `default` profile to a private bot named **Hermes**. Additional bots use native profiles in that same runtime. New bots use the built-in Moss companion, with no catalog artwork prerequisite. This does not change the organization's default coordinator. Names and avatars remain editable.

Settings adds one collapsed Personal Hermes section under Connected accounts. The normal bot editor's existing Hermes connection selector offers **My Hermes runtime · new private profile**. Existing Skills and Memory panels display escaped, read-only native content and Refresh; there is no native installation/editor UI. Native chat can change its own resources under normal Hermes approval rules. Externally created native profiles appear only in **Unlinked profiles → Add as bot**. Backups, arbitrary marker-only directories, symlinks, default and already-bound identities are excluded. Renamed/replaced profiles require operator reconciliation; a binding is never silently reassigned.

## Scope and dependencies

This change targets main directly. It extracts the pinned native RPC/controller foundation developed in PR30, but does not enable its host-process installer, host setup UI, or compose overlay. PR30 and PR35 remain parked; neither must be merged/deployed first. Remote/manual and advanced managed Hermes remain available. No database migrations are added or modified: private `ai_apps.provider_config.docker` and `bots` rows hold the immutable broker mapping, with a transaction/advisory lock and existing pet relations.

Pinned upstream source: official Hermes **v2026.9.24**, commit `f97608f178d1ffeca59860195ab7da295f7c8e5f`. The bridge verifies this source marker and the native handshake checks ping, approval requests, and exclusive submit capabilities. The selected official Linux amd64 image is:

```
nousresearch/hermes-agent@sha256:2fd023efbb8d3d2b0ce1a73d028b07370cff34f567cfe0e999553e8c327ea283
```

The corresponding arm64 release manifest is `sha256:93b4e2877a2f48f4474b6dd2b99386ae32c4c552d32639df1a869b3f13c50b5a`; arm64 is not lifecycle-tested here. Moving tags, arbitrary registry names and browser-selected images are rejected. Do not update the pin without rerunning the native protocol/lifecycle suite.

Official references: [Docker](https://hermes-agent.nousresearch.com/docs/user-guide/docker), [profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles), [pinned source](https://github.com/NousResearch/hermes-agent/tree/f97608f178d1ffeca59860195ab7da295f7c8e5f). Current docs alone are not the compatibility contract. This release uses s6 initialization and native profile reconciliation; readiness waits for its supervised main service, seeded profile, and actual protocol handshake.

## Trust and isolation

This is hardened **trusted-user isolation**, not a claim that Docker is a perfect sandbox. A trusted host broker alone can invoke Docker. Neither web/worker nor native agent containers receive a Docker socket, host runtime credentials, other users' storage, privileged mode, published ports, or host PID/network namespaces. The broker's protected Unix socket is powerful: membership in its trusted group is equivalent to control of enrolled personal runtimes. Never expose it over TCP or mount it in an agent container.

The server derives owner IDs from fresh principals. Enrollment requires `DOCKER_HERMES_ALLOWED_USER_IDS`; admins have no automatic access to other users' personal profiles. Bot creation permission is checked independently using the existing tools/bot-creation policy. Both app actions and broker leases distinguish creation from existing chat access. Private owner checks apply to bot/app lookup, profile discovery/link/read, native commands, runs, streaming batches and cleanup. Shared snapshots, templates, duplication, group chat, delegation, service execution and routines cannot use personal bindings. Company connection and bot lists omit others' personal metadata.

Each runtime has a deterministic hashed owner name and exactly one native Docker volume at `/opt/data`. SQLite/WAL data stays on a native volume, not a Docker Desktop host bind mount. The only other mount is the trusted read-only Python bridge. Inspection checks image, ownership labels, mount destinations, capability set, resource limits, restart policy and actual network attachments. Storage collisions are refused. Defaults are 2 GiB RAM (no extra swap), 2 CPUs, 256 PIDs, 25 enrolled runtimes and 16 profiles per runtime. Official s6 bootstrap runs with only CHOWN, DAC_OVERRIDE, SETUID and SETGID; all native operations run as UID/GID 10000 with no-new-privileges.

Credentials/configuration remain native. Root-profile OAuth inheritance stays inside the same user's runtime. Resource views read only bounded regular SKILL.md and fixed memory files, without following symlinks, hardlinks or special files; known secret patterns are redacted. They never return config, `.env`, auth stores or raw native stderr. Redaction is defense in depth, not a general secret detector. Users control their own native code/resources within their container; hostile users require stronger isolation.

**One native writer per profile:** broker controllers hold a profile inode lock and reject detected independent native CLI/gateway processes. A cold enable stops/drains the previous container before reopening profiles. A preflight scan cannot prevent a trusted operator or approved terminal command from launching a second writer later: upstream native CLI does not honor the bridge lock. Stop UI ownership before independent CLI/gateway maintenance; do not launch another writer from an active bot's terminal. Profile create/list operations are supported; independent chat/gateway processes on an owned profile are not. This is an explicit trusted-operator restriction, not enforcement against arbitrary same-user code.

## Operator setup (review first; no installer runs automatically)

1. Use a dedicated Linux host/broker account with narrowly controlled Docker access. Keep web/worker in an account without Docker access. Install this repository's locked Node dependencies for the broker. Keep its source/config/state inaccessible to native containers and nontrusted users.
2. Prepare canonical private state and trusted-group IPC directories. Bridge source must be non-group/world-writable and world-readable (public code mounted for UID 10000). Config is operator-owned and never accepted from the browser.
3. Supply an absolute broker JSON file, for example:

```json
{
  "socketPath": "/run/collective-hermes/broker.sock",
  "stateDir": "/var/lib/collective-hermes-broker",
  "bridgePath": "/opt/collectiveui/src/docker-hermes/bridge.py",
  "namespace": "cui-personal",
  "image": "nousresearch/hermes-agent@sha256:2fd023efbb8d3d2b0ce1a73d028b07370cff34f567cfe0e999553e8c327ea283",
  "network": "none",
  "memoryMb": 2048,
  "cpus": 2,
  "maxUsers": 25,
  "maxProfiles": 16
}
```

4. Start `npm run hermes:docker -- /absolute/broker.json` under an operator-managed supervisor. The broker does not load the app `.env`. Configure BOTH web and worker with `DOCKER_HERMES_SOCKET` and the explicit comma-separated `DOCKER_HERMES_ALLOWED_USER_IDS`. The worker must be running; it renews authorization leases every 15 seconds and completes durable app pairing.
5. Use Settings → Connected accounts → Personal Hermes → Enable. Progress reflects actual image, storage, container, native and pairing stages. Runtime-ready does not imply provider credentials or paid inference have been verified. Authenticate/configure the native profile only inside that user's runtime using the separate maintenance procedure and chosen provider. No credentials are copied from the host/app or another user.

### Network choices

The default `network: "none"` is deliberately offline. Provisioning, profile views and local disposable provider tests work; external providers/tools do not. Production online chat requires separately reviewed egress infrastructure. The broker never creates networks, changes firewall rules or configures credentials.

For `network: "proxy"`, the operator must provide one **internal Docker bridge per owner with isolated gateway mode**, named `<namespace>-<sha256(app-user-id)>-egress`, labeled `collective.owner=<hash>`, `collective.namespace=<namespace>`, and `collective.egress-policy=deny-private-allowlist`. The broker additionally requires `com.docker.network.bridge.gateway_mode_ipv4=isolated`, and `com.docker.network.bridge.gateway_mode_ipv6=isolated` whenever IPv6 is enabled; trusted host interfaces are refused. Docker's ordinary internal mode still exposes bridge-address host services, so it is insufficient ([Docker gateway modes](https://docs.docker.com/engine/network/port-publishing/#gateway-modes)). Its only other peer may be the reviewed proxy (`collective.egress-proxy=true`, alias `hermes-egress`, port 3128, no native data mounts). The runtime has exactly this network, no default bridge or published ports, and fixed HTTP(S)_PROXY settings. The proxy must allowlist required provider/public domains, validate DNS answers and redirects, and deny loopback, RFC1918, link-local/metadata, private IPv6 and host/service destinations. HTTP CONNECT must receive the same treatment. Labels describe operator attestation; the broker cannot validate the proxy's filtering implementation. With that isolated bridge configuration, direct external routing is unavailable; the operator must also verify host-service, private-address and proxy-bypass denial on the intended Docker host. This proxy mode is not end-to-end tested with external providers here.

### Stop, revocation and crash recovery

The broker pins its deployment configuration in `stateDir/deployment.json`; changing namespace/image/network or other configured values is refused until an operator plans a stopped-runtime migration using the original config. It never silently selects a new volume while stranding the old container. The broker stores fsynced owner journals and write-ahead bot/app IDs outside native containers. Repeated/parallel enable/create/link requests reuse mappings. Only successfully handshaken bindings are published. Application pairing is idempotent and can complete after reload/worker restart. A restarted broker stops retained runtimes before serving requests; it never silently resumes uncertain chat turns. Creation receipts retain profile names and reject changed request payloads.

The worker stops disabled/revoked/unregistered owners and invalid private bindings. Missing lease renewal stops active runtimes after approximately 60 seconds **while the broker is alive**. Failed stops remain an explicit error and are retried, never reported as stopped. Normal stop/cancel/setup failure preserves the container's volume, native sessions, skills and memory. A failed native transport stops the whole owner's container, so sibling profile chats can be interrupted; the UI should be explicitly restarted after that failure.

**A dead broker is not a watchdog.** `--restart no` does not stop already-running containers after a broker crash. Deploy with supervisor failure cleanup before enabling real accounts. For systemd, configure an `ExecStopPost` invoking the same locked Node/tsx entrypoint with `/absolute/broker.json --stop-retained`; use the same broker account and private config. That command refuses a live recorded broker PID, verifies each retained owned runtime, stops it, and clears the stale lock only after confirmed cleanup. Do not blindly delete `broker.lock`. An operator must reconcile Docker/configuration drift that prevents verified cleanup. Supervisor SIGKILL/host-reboot behavior still requires a staging check on the intended host; no live systemd or firewall change was made in this work.

There is no purge/uninstall-data endpoint. Removing enrollment stops access but retains data. Back up both native volumes and broker journals/app database together; losing mappings is not permission to adopt another directory or silently switch ownership.

## Verification

- `npm test -- --project unit` — broker receipts/races/cancellation/restart, native protocol mapping, owner policy and independent security regressions.
- `DOCKER_HERMES_DB_TEST=1 DATABASE_URL=.../collective_docker_hermes_test npx vitest run --project integration tests/integration/docker-hermes.test.ts` — real disposable PostgreSQL, mocked broker; existing unmodified migrations required; no catalog artwork is needed.
- `DOCKER_HERMES_NATIVE_TEST=1 npx vitest run --project sandbox tests/sandbox/docker-hermes-native.test.ts` — actual disposable containers/volumes, pinned official native code and local mock provider; no real credentials/inference. The fixture deletes only its exact disposable Docker objects. It does not purge production data.
- `tests/fixtures/docker-hermes-browser.ts` plus `playwright.docker-hermes.config.ts` — guarded named disposable DB, synthetic native RPC/resources, real app/worker/Chromium. Set `DOCKER_HERMES_BROWSER=1`, local auth test environment and the generated `/tmp/docker-hermes-browser.env` in both app and worker. This is browser/application evidence, not actual Docker evidence.
- `npm run typecheck`, `npm run lint`, `npm run build`.

The execution environment's Docker VFS driver exhausted storage pulling the original layered image. For lifecycle tests only, every upstream layer digest and image config was verified, OCI whiteouts merged, and the exact resulting root filesystem imported as one local test layer. `DOCKER_HERMES_TEST_ROOTFS` enables a test-only driver substitution and checks its provenance label. Production accepts only the official digest; the imported test image is never deployed. These tests verify native code and actual Docker lifecycle, but do not establish that the original layered pull succeeds on a deployment host. No paid provider, real credentials, production deployment, external egress policy or live service installation was tested.

### Review evidence

Independent security review added 16 regression cases, including a real child-process SIGKILL/socket-rebind test and proxy gateway/network drift checks. Full unit suite: 642 tests. Disposable PostgreSQL integration: 6 tests. Chromium: 2 scenarios covering enable/reload, automatic starter pairing, native read-only views, chat, new private profile creation, mobile layout, editable names and cross-admin denial. Native Docker suite: 5 scenarios, including one-time approval, cancellation, resumed sessions and rejection of an already-running ordinary Hermes CLI. See the PR for the final check results and commit.
