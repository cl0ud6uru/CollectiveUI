# Personal Codex app-server harness

Codex bots run in the acting caller's private Docker runtime. **Settings → Connected accounts → Connect ChatGPT for Codex** connects once for all that caller's Codex bots. CollectiveUI login is a separate session. Sharing a bot shares its definition; it never shares the bot owner's account, native history, workspace, or credentials.

This pilot implements native command/file execution, visible command and file items, persistent native thread continuation, durable browser reconnect, and Stop. It requests standard speed and checks the exact model/effort against the native catalog. No pooled account, organization API key, or automatic API-funded fallback exists. Legacy operator-assigned manifest runtimes retain the PR140 text-only behavior described below.

**Activation is blocked in this task environment.** The real pinned binary starts, reports the managed policy, and retains both volumes after container replacement. Its command sandbox cannot create the required unprivileged namespace under the proposed Docker constraints. Provisioning refuses native sign-in when that probe fails. The implementation has not deployed a runtime, signed in an account, or performed live inference. See [native evidence](reviews/personal-codex-native-evidence.json).

## Verified official protocol

The adapter preserves the existing exact pin, **0.163.0-alpha.2**, upstream commit `a6274249d5877030676db098914db686bab7c921`. This is a released prerelease, not the latest stable release: the [official releases](https://github.com/openai/codex/releases) list 0.162.1 stable and newer 0.163 alpha builds as of 2026-10-12. No version upgrade is silently accepted; another pin needs protocol and native sandbox validation.

The official [app-server authentication documentation](https://learn.chatgpt.com/docs/app-server#authentication) describes managed device-code login. `account/login/start` with `type: "chatgptDeviceCode"` returns a native login ID, OpenAI verification URL and one-time user code. Codex persists and refreshes its own grant. The broker matches completion IDs and rereads authoritative account facts. It never receives API keys or imports tokens from SIWC, dot, provider connections, or another native runtime. The internal-only `chatgptAuthTokens` login mode is unused. See the [pinned account protocol](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/app-server-protocol/src/protocol/v2/account.rs).

Experimental API capability is explicitly enabled for named native permissions, actual `account/read.workspaceRouting.chatgptAccountId`, and permission provenance. The selected native workspace ID and normalized account email are bound to a server-generated account revision. This metadata and a catalog entry are not entitlement proof. Native model access still needs a successful authorized turn.

## Personal connection and storage

1. A valid CollectiveUI caller starts connection from Settings. The protected broker admits only an operator-enrolled owner, provisions their dedicated runtime, validates its actual Docker configuration, and probes native sandbox execution before asking OpenAI for a device code.
2. The caller opens OpenAI's page and signs into their **own** subscription account. Only the short-lived device code and public account facts reach the browser. This pilot requires the native account email to match the caller's CollectiveUI email or UPN; this is an explicit pilot ownership policy, not an OpenAI protocol requirement.
3. The caller confirms the displayed account. Confirmation rereads native account/workspace facts under the owner lock, applies the installation's existing personal-plan/workspace policy, and records only metadata. A normalized email cannot be actively connected to two callers. Jason and his boss must each complete their own ceremony.
4. Every bot uses that caller's connection. A different account/workspace rotates the binding; existing chats require a new conversation. Disconnect logs out native auth but keeps files and native history. Cancellation/disconnection remains available to an authenticated owner after connection policy is revoked, once active work has stopped.

A non-secret durable sign-in marker precedes the native login write. A lost reply or broker restart cannot silently replay that write. Known codes live only in broker memory. When completion cannot be established, Settings requires explicit cancellation; cancellation always requests native `account/logout`, revoking any grant that completed concurrently and canceling pending native login before another attempt. No token or code is written into the marker or application database.

The runtime has two independently named, owner-labelled local Docker volumes: `/codex-home` for native auth/history and `/home/agent/workspace` for work files. Both are private to UID 10001. Replacing the container reuses the volumes. The application does not delete either volume on bot/chat deletion, disconnection, or recovery. Native data has no automatic retention cleanup in this pilot; backup, restore, owner offboarding and deletion need an explicit operator procedure.

The workspace root and capabilities consume `src/lib/workspaces/contracts.ts` from foundation commit `d99468e`. Migration **0054** belongs to that foundation; Codex adds **0055**. Template catalog assignment, instance adoption, seed images, office/.NET tooling and interactive desktop are separate workspace work. This pilot does not claim those integrations are active or register another general workspace catalog.

## Installed runtime boundary

`src/personal-codex` is a separate Docker broker. Only this trusted host-side service can invoke Docker. Web/worker receive access to its protected Unix socket through `PERSONAL_CODEX_SOCKET`; agent containers receive neither that socket nor the host Docker socket. HTTP/WebSocket are IPC adapters on that socket, with the caller owner set by authenticated server code. No browser-supplied owner, image, endpoint, path, mount, command, credential or network rule is accepted.

`PERSONAL_CODEX_BROKER_CONFIG` names an operator-installed, server-only JSON file. This is a schema illustration, **not installed configuration**:

```json
{
  "socketPath": "/run/collective-codex/broker.sock",
  "image": "collectiveui/personal-codex@sha256:<reviewed-immutable-image-digest>",
  "namespace": "cui-codex-personal",
  "owners": ["jason-collective-user-id", "boss-collective-user-id"],
  "memoryMb": 2048,
  "cpus": 2
}
```

The socket directory must be protected, normally 0750 with the broker owner and authorized web/worker group; the socket is 0660, sign-in markers 0600. `npm run codex:personal` runs the host-side broker in plain Node. Shared Codex modules use Node-only dependencies rather than the React Server Component `server-only` marker, so the standalone worker can also import dispatch and recovery without special React conditions. A stale socket collision fails closed and needs reconciliation. A graceful broker restart closes transports while retaining running containers and volume data.

Build/review `docker/personal-codex/Dockerfile` separately and install its immutable digest. The provisioner never builds, pulls, publishes, creates a network, or changes host security settings. Each owner needs a preinstalled internal isolated-gateway bridge named `<namespace>-<sha256(ownerId)>-egress`, with owner/namespace labels, ICC disabled, and only the runtime plus an approved owner-labelled, unmounted allowlist proxy. The proxy alias is `codex-egress:3128`. Proxy behavior and its permitted TLS destinations require operator review; labels alone do not attest its policy. There are no published runtime ports. Native app-server listens only on container loopback; a fixed Docker-exec bridge connects it to the broker.

ICC disabled blocks runtime-to-proxy traffic by default. The separately approved host network policy must allow only that owner's runtime to its approved proxy on TCP 3128, with established return traffic. Review the proxy's uplink and TLS destination allowlist, and verify the alias, proxy reachability and native authentication path before activation. Other peers, host services and destinations stay denied. The driver neither installs this forwarding exception nor attests its enforcement; this PR does not supply a production proxy or firewall configuration.

The driver validates actual mounts, volume ownership/options, image, exact effective environment, user, command, root read-only mode, dropped capabilities, no-new-privileges, no host PID/IPC/UTS/user namespace overrides, memory/CPU/PID limits, no devices, extra hosts, bind mounts, ports, logging, or extra network peers. It refuses configuration/storage collisions. It never adopts another person's volume or creates replacement storage while validating an existing container. Recovery **Start my Codex runtime** starts only the exact retained validated container, even when an unresolved attempt blocks new work; it does not create storage or change a grant.

## Native permissions and approvals

A read-only image-owned `/etc/codex/requirements.toml` supplies the `collective-personal` profile, workspace writes, no tool network access, user review, ChatGPT-only login, OpenAI provider, and managed protected-file denials. Auth/config/session/log paths plus `/proc` and `/sys` are denied. The profile denies the auth home and workspace `.codex` directory. Codex's required helper alias directory is the deliberate narrow native read exception; mandatory whole-home denial would conflict with its startup helper grant. No configured MCP servers/apps/plugins are admitted. Native hooks, memories, shell snapshots, image generation and multi-agent features are disabled.

Startup and each thread request explicitly mark the canonical project untrusted and clear legacy `notify`, preventing app-server from enabling workspace-supplied configuration when a writable thread begins. The [pinned thread implementation](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/app-server/src/request_processors/thread_processor.rs#L1353) otherwise can auto-trust writable marked projects. Permission profile provenance, account mode/workspace, model/provider and cwd are checked before dispatch.

Ordinary non-dangerous commands using the existing sandbox, and file patches constrained to writable paths, execute natively without an interactive approval. Examples include listing files, creating/editing scripts, and running installed Python or Node against workspace files. `on-request` is distinct from native `UnlessTrusted`: marking the project untrusted disables workspace configuration rather than requiring approval for every command. This follows the pinned [command approval policy](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/core/src/exec_policy.rs#L809) and [patch safety check](https://github.com/openai/codex/blob/a6274249d5877030676db098914db686bab7c921/codex-rs/core/src/safety.rs#L67).

Their started/completed items, command output and diffs become durable chat tool parts. Native callbacks can still arise for dangerous commands even inside the workspace, explicit sandbox override requests, or file changes outside writable paths. Only command/file approval callbacks are supported. Their cards offer **Deny** (native `decline`, let Codex try another approach) or **Stop** (`cancel`). Thus this pilot provides automatic ordinary workspace execution, but not unrestricted execution of every workspace command: an operation requiring native approval cannot be positively approved yet. Permission/network expansion, accept-for-session rules, interactive input, dynamic tools and other approval kinds are unavailable. No approval is auto-accepted. Decisions are owner/run/binding/thread/turn scoped, expire, and are not replayed on reconnect. Resolved callbacks and canceled turns remove stale cards.

The pinned native sandbox needs functioning bubblewrap namespaces under these exact unprivileged container constraints. A successful configuration report is not enough. Do not add privileged mode, SYS_ADMIN, an unconfined seccomp profile, or host namespace/network access to make a failed probe appear successful.

## Thread continuity, cancellation and uncertainty

`codex_threads` binds a conversation to its caller, account/runtime revision and bot revision. First input creates persistent native history with the explicit supported legacy history mode; a follow-up resumes **that thread ID** and sends only the new user text. It does not reconstruct the conversation each turn. Regeneration/edited branches and changed account/bot revisions require a new conversation rather than silently contaminating native history.

`codex_runs` retains a unique nonterminal attempt per caller, independent of chat deletion. Before `turn/start`, the worker rechecks the current principal/session, bot target and runtime binding, then durably records uncertainty. It also stores the preceding native turn ID and sends the run ID as `clientUserMessageId` for correlation, **not idempotency**. A lost dispatch acknowledgment is never replayed automatically. Recovery only reads/interrupts the recorded thread and requires a new terminal turn; an old completed turn cannot confirm an uncertain new dispatch.

Browser reconnect tails the application's durable event log. Provider transport loss ends the stream and invokes stop/recovery. Interrupt acknowledgment alone is insufficient: native turn state must be terminal. Unconfirmed stops block new work and account mutation. A stopped retained runtime can be restarted for that inspection. If native termination still cannot be established, the original runtime needs operator inspection; there is no force-clear UI.

Managed `account/updated` snapshots trigger a generation-aware account reread. Terminal success waits for pending identity verification, so a delayed mismatched response cannot be ignored after `turn/completed`. Initial same-account routing/refresh notifications do not themselves claim an account change.

Subscription usage is `chatgpt_plan` / `codex:chatgpt_subscription`. Thread-cumulative token totals use a known baseline delta, not repeated cumulative billing. Counts remain unknown after lost usage/recovery rather than estimating. No company-funded title/memory side calls are made. The separate existing allowance bridge is not automatically adopted by this runtime.

## Hermes compatibility

Investigation confirms Hermes supports ChatGPT/Codex subscription inference through its `openai-codex` provider and native device-code login. Its [pinned official auth module](https://github.com/NousResearch/hermes-agent/blob/f97608f178d1ffeca59860195ab7da295f7c8e5f/hermes_cli/auth_codex.py) stores that grant in Hermes auth storage, defaults to a fresh native login, and recommends a separate session because refresh tokens rotate. It also contains optional CLI-token import/recovery paths; these are not a verified shared refresh owner across isolated engines and are unused here. Within one person's Hermes runtime, default-profile inheritance is a distinct native feature with source-store refresh locking.

CollectiveUI's existing Hermes subscription flow is profile-scoped (`HermesCodexConnection`, `/api/bots/[id]/native/codex`); central Connected accounts currently contains the Personal/Remote Hermes runtime managers, not a new all-profile subscription grant. The new central Codex connection is reused across Codex bots only. One central account-management surface could expose both engines' owner-bound status and separate native connection ceremonies, but sharing the Codex app-server grant with Hermes would require a reviewed adapter/refresh-ownership design. This PR implements neither that adapter nor centralized Hermes subscription login. SIWC identity tokens and copied auth files are not substituted for native model access.

## Validation and activation approvals

The [minimal VM readiness check](personal-codex-vm-readiness.md) lists read-only prerequisites, the no-credentials native gate, and exact separate installation/login approvals.

Unit tests use synthetic app-server transports and PGlite applying all migrations. They cover two callers, funding/account checks, real Unix broker routing, Docker isolation/collisions, owner policy and generation changes, tool projection, same-thread follow-ups, cancellation, pre-ack events, stale approval resolution, explicit decisions, uncertain dispatch and preceding-turn recovery. Browser fixtures render the actual editor/connection/approval components at 320/390/768/1280 widths with synthetic endpoints.

Reproduce the native probe without credentials or inference:

```sh
scripts/build-personal-codex-fixture.sh
node scripts/probe-personal-codex.mjs
```

The fixture builder downloads the exact public Linux x64 package and builds offline with the production policy/wrapper. It omits production git/python packages; it is not a deployment image. The probe creates only disposable volumes, tests protocol/policy, attempts native execution/protected reads/symlink/network restrictions, and checks volume retention after container replacement. Its current result is **unverified, exit 1** because native execution is blocked. Protected-read and network enforcement have consequently not been demonstrated. No actual OAuth, entitlement, paid turn, native follow-up after paid tools, or production proxy test was performed.

Activation needs separate explicit approval to:

1. Review/install the production image digest and broker service, apply migrations 0054/0055, and enroll the exact CollectiveUI owner IDs with protected web/worker IPC access.
2. Select an approved execution host supporting the required namespaces under the existing constraints. Any host/security policy change requires its own review/approval; none was performed here.
3. Review/install each owner's dedicated proxy, the narrow runtime-to-proxy forwarding exception described above, its uplink/TLS allowlist, persistent storage/backups and retention procedure. Verify native authentication reachability while other peers/host/destinations remain denied. No live network or storage configuration is supplied by this PR.
4. Enable the installation's personal ChatGPT policy for the intended callers/plans/workspaces. Each caller must then use the central Connect ChatGPT flow, enter their own OpenAI code, and confirm their own matching account.
5. Run separately authorized native account/model/tool tests for each caller: create a harmless file, stop a long command, follow up on the same thread, restart/replace the retained container, verify history/files remain, and prove that the other caller's data/credentials are inaccessible. Approval/network expansion remains deferred.

## Legacy manifest text pilot

`CODEX_RUNTIME_MANIFEST` remains available for legacy assignments. Its strict version-1 schema is in `src/lib/codex/runtime.ts`. Each runtime supplies unique ID/owner/funding, WSS or numeric-loopback WS endpoint, protected token file, isolation ID, credential-binding revision, absolute cwd, and explicit isolated/no-MCP assertions. Subscription assignments additionally require expected email/workspace and the prior independent authorization reference/expiry; they still enforce caller email and forced native login/workspace policy. These are trusted installation assertions, not container attestation or entitlement proof.

Legacy manifest runtimes remain read-only text chats with tools/approvals/attachments refused and a new native thread per turn. Their existing cancellation/uncertainty guards remain. When the personal broker is configured, subscription bots require the caller's managed personal connection; failure never selects a legacy, bot-owner, or API-funded account instead.
