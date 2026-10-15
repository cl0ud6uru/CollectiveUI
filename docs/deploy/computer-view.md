# Optional local computer view with Docker Sandboxes

**Deployment status: disabled pending live SBX and SIWC verification.** The adapter has fake-CLI coverage; live `sbx inspect` payloads, resource fields, digest semantics, and desktop image boot remain unverified here. The integrated main SIWC sign-in path is implemented, but the operator proof `siwcSandboxVerified` remains `false` by default for every backend, including SBX. Keep the existing Docker backend enabled until the live SBX smoke, authenticated inference, and credential-containment proof below pass on a supported Linux host. Synthetic tests do not establish production credential isolation.

Historical host evidence: earlier development-host observations reported no usable `/dev/kvm`. A separate October 14, 2026 operator check reported Ubuntu 24.04.5, nested virtualization enabled, `vmx`, and `/dev/kvm` mode `0660` owned by `root:kvm` with KVM API 12. That check did not establish access for the eventual service account. SBX installation and service-account/KVM membership were still deferred. Recheck the target host and service identity before testing; these observations do not attest to current live readiness.

This backend is opt-in. It preserves CollectiveUI’s unified ChatGPT sign-in and SIWC-managed identity; the desktop’s native device-code login is obsolete and must not be used. The adapter does not add a provider or expose credentials to the GUI. Before an operator approves `siwcSandboxVerified`, stock Codex token synchronization is unavailable and SBX must remain disabled.

## Build and pin the desktop image

Start with the operator-reviewed personal Codex runtime image by immutable digest. Build the desktop variant from the repository root. The derived image copies the repository's current `docker/personal-codex/server.mjs` to `/opt/collective-codex/server.mjs`, along with the private desktop/control files from `docker/computer/`; it does not rely on the base image already containing the current SIWC-aware stock supervisor or fd 3 `--stdio-token` support. Keep the immutable base digest, review the copied supervisor and desktop proxy together, and verify the resulting image contains the expected compatible Codex runtime before promoting its derived immutable digest.

```sh
docker build \
  -f docker/computer/Dockerfile \
  --build-arg BASE_IMAGE='registry.example/collectiveui/personal-codex@sha256:<reviewed-base-digest>' \
  -t registry.example/collectiveui/personal-codex-computer:reviewed .
docker push registry.example/collectiveui/personal-codex-computer:reviewed
```

Resolve and record the resulting image’s immutable `registry/repository@sha256:...` reference. Do not put a mutable tag in broker configuration. Make that exact image available to the local `sbx` image store using the v0.48.0-supported image archive/template workflow, then verify it appears in `sbx template ls --format json`. The exact digest resolution through `sbx template load` has not yet been exercised; confirm that `sbx create shell --template <digest-reference> --pull never` uses that same digest before enabling the backend. Do not substitute an unverified tag if the store cannot address the image by digest.

The broker creates a no-workspace `shell` sandbox with explicit CPU and memory values, `--skills off`, and no kit, environment, secrets, MCP, or published-port options. Every `sbx` subprocess runs from the protected, empty `$sbxHome/collectiveui-empty-cwd` directory, never from the repository, a world-writable directory, or `$sbxHome` itself. The broker creates it as mode `0700`, checks its owner/mode/no-symlink status, and rejects any content before invoking the CLI. This prevents project-local YAML or hooks from influencing sandbox creation. The image must retain the stock Codex bridge and provide `/opt/collective-computer/control.py` with `screenshot`, `input`, `pause`, and `resume` operations.

## Host preparation

Deploying the web application does not install SBX, create a broker service account, or grant Docker/KVM access. A host operator must approve and perform those steps separately. Verify Docker and `/dev/kvm` access under the actual service identity, then run the following CLI checks with `HOME` set to the configured `sbxHome`, matching the broker subprocess environment.

Install the official `sbx` CLI at exactly `v0.48.0`; another version is rejected because the CLI’s JSON output changed across releases. This prototype requires local Linux Sandboxes, a working Docker daemon, and a host with KVM available to the sandbox runtime. Verify `sbx version --format json` reports client version `v0.48.0`, and verify the daemon and a disposable sandbox can start on the target host.

The runtime requires SSH agent forwarding to be disabled and the fixed agent socket path to be empty. Check both values using the v0.48 CLI and inspect the JSON values locally:

```sh
sbx settings get ssh.agentForwardingEnabled --json
sbx settings get ssh.agentSocketPath --json
```

The first setting must be `false`; the second must be an empty string. The broker does not change host settings. It fails closed if either setting cannot be read or has another value. Recheck after host settings or CLI changes.

Create a private, operator-owned directory for the `sbx` subprocess HOME and adapter binding ledger. It must be owned by the broker service account and not writable by group or other users; the broker writes the ledger as mode `0600`:

```sh
install -d -m 0700 -o <broker-uid> -g <broker-gid> /var/lib/collectiveui/sbx
```

The ledger is stored at `/var/lib/collectiveui/sbx/collectiveui-personal-codex-bindings.json`. It binds each approved owner hash to the immutable sandbox ID, name, template digest, CPU count, and memory allocation. Do not copy, edit, or prepopulate this file. A matching sandbox name without a broker-created ledger entry is rejected rather than adopted. The sandbox has no host workspace or host-home bind mount; Codex account data remains in that owner’s isolated sandbox filesystem.

## Opt-in broker configuration

Install the following as the broker’s protected JSON configuration, with mode `0600`, and set `PERSONAL_CODEX_BROKER_CONFIG` to its absolute path. Replace every example value with the existing deployment’s socket, namespace, admitted owner IDs, and reviewed image digest. Owner IDs are the same IDs already admitted by the personal Codex broker.

```json
{
  "backend": "sbx",
  "socketPath": "/run/collectiveui/personal-codex.sock",
  "namespace": "cui-codex-prod",
  "owners": ["member-101"],
  "template": "registry.example/collectiveui/personal-codex-computer@sha256:<reviewed-desktop-digest>",
  "sbxExecutable": "/usr/local/bin/sbx",
  "sbxVersion": "0.48.0",
  "sbxHome": "/var/lib/collectiveui/sbx",
  "adminEnabled": false,
  "memoryMb": 4096,
  "cpus": 2
}
```

`sbxExecutable` may be `/usr/local/bin/sbx` or `/usr/bin/sbx`; `sbxVersion` must be `0.48.0`. `memoryMb` is an integer from 512 through 65536, and `cpus` is an integer from 1 through 64. The config schema rejects extra fields. In particular, it has no hook, kit, shared-skill, secret, host-path, or credential settings.

## Optional SBX administration panel

The **Docker Sandboxes** admin page is available at `/admin/docker-sandboxes` to web administrators. Its broker feature flag is `adminEnabled`, which defaults to `false`; the example above leaves it off. To deliberately use the panel in a staging installation, set `"adminEnabled": true` in the protected SBX broker JSON config and restart the broker. The web app’s `PERSONAL_CODEX_SOCKET` must match the broker’s protected `socketPath`. This flag exposes admin APIs only through the existing protected broker socket and web admin authorization. It does not make the SBX backend ready or change the separate `siwcSandboxVerified` proof gate. Keep it off unless the host operator intends to grant administrators these controls.

The page’s **SBX setup help** opens an in-page checklist for this runtime; it does not route to the separate Workspaces service. If the broker cannot be read, counts, settings, and inventory are shown as unknown/unavailable. A configured socket alone does not identify the backend, and refreshing an unavailable snapshot does not report successful host inventory refresh.

The panel can manage owner admission, runtime lifecycle, the approved template catalog, default template and new-runtime CPU/memory/capacity settings, owner-scoped network rules, sanitized diagnostics, and operator validation records. These controls do not edit immutable host configuration such as backend selection, SBX binary/version, namespace, socket, `sbxHome`, or the host's SSH/KVM settings. Those remain in the protected broker and host configuration.

Admin state is durably recorded in `$sbxHome/collectiveui-admin.json` as a private, mode-`0600` broker-owned file with atomic updates and revision checks. The first initialization seeds known/admitted owners from the protected `owners` config. The panel's enrollment changes update this durable owner policy; future `owners` values in protected config are merged as known owners. Do not create, copy, prepopulate, or hand-edit the state file. A state-file ownership, permission, schema, or reconciliation error fails the admin view/actions closed and needs operator repair.

Changes to CPU, memory, or default template apply only when a new VM is provisioned. Existing owner bindings, VM IDs, guest files, and their original resource/template assignments remain intact. The maximum running count applies to every subsequent provision/start, including retained VMs; lowering it does not stop already running machines. Stop a running VM or raise the limit before starting another. Removing an owner's admission blocks new use before stopping its VM and retains the VM and data. If stopping fails, access remains revoked and repeating removal retries the stop. Use the separate lifecycle **Delete computer** action only when guest data should be removed: it requires typing `DELETE`, removes the VM and guest files, and retains the person's database identity and ChatGPT connection.

Template operations accept only immutable digest references. **Import from host inbox** is not a browser upload: an operator must place a reviewed regular `.tar` archive in `$sbxHome/template-imports`, owned by the broker account and inaccessible to group/other users. The broker creates this directory privately (mode `0700`) and lists only safe archive names; imports are bounded to 8 GiB per file and 100 entries. Import calls the pinned CLI on that exact inbox file, then verifies that the digest appears in the local template catalog before it becomes approved. No files are extracted into the web app or uploaded from the administrator's browser.

Network rules recorded by this panel are app-managed and scoped to one owner's sandbox. The panel does not claim they describe every host or SBX network rule. Host policy is shown as observed only when the pinned CLI response matches the understood schema; unrecognized or unavailable policy is shown as unobserved, and a network check returns **unknown** when there is no definitive decision. Recent events are separate host observations and may be unavailable. Never interpret a missing event list as proof that no traffic occurred or that a destination is blocked.

Network mutations and template imports persist an intent before invoking the CLI. If a crash leaves a newly matching network rule whose ownership cannot be established, the broker retains the receipt and reports that operator reconciliation is required; it does not adopt or delete the ambiguous rule. Review the local policy and receipt before repair or retry.

Diagnostics return a sanitized summary of recognized host checks, not raw CLI output, owner credentials, screenshots, or conversation data. Operator validation records save the administrator, evidence reference, selected template, and manual pass/fail/pending result; these are attestations, not automatic verification. Neither diagnostics nor panel validation can enable or override `siwcSandboxVerified`; only the separately reviewed operator proof in the live preflight can do that. The deployment remains blocked until the live SBX, authenticated inference, and credential-containment checks below pass.

The protected proof applies only to the exact `template` digest in the operator's broker configuration. A new default chosen in the panel does not inherit that approval: token synchronization is blocked for its VMs until an operator reviews that digest and updates protected configuration. Existing VMs retain their recorded template and are evaluated against that binding. Changing the panel's default also resets its manual evidence records.

The backend selector defaults to Docker when omitted, preserving existing deployments and their Docker config. To roll back, restore the existing Docker configuration (omit `backend` or set it to `docker`) and restart the broker. Do not delete owner sandboxes or their ledgers as part of a backend switch; use the explicit cleanup path after reviewing the data-retention impact.

## Required live preflight before enabling

Use a staging broker and one disposable admitted owner first. A fake CLI test is not a substitute for this gate. Confirm all of the following on the target Linux/KVM host with the exact pinned CLI and desktop image:

1. The `sbx` daemon is healthy, `/dev/kvm` is available to it, the reviewed digest is in the local image store, and a no-workspace sandbox starts with the configured CPU/memory limits.
2. Capture the actual `sbx ls --format json` and `sbx inspect --format json <staging-name>` structures locally. Verify the immutable ID, image digest meaning, state, empty workspace/mounts/kits/secrets/published ports, SSH forwarding status, and recorded CPU/memory fields match what the adapter validates. The adapter deliberately rejects unknown or incomplete inspect data. Do not weaken the validator to accommodate a schema until the v0.48.0 output has been reviewed.
3. Keep an app-server bridge open while requesting screenshots and computer input. Confirm a healthy active `sbx exec` session does not make routine inspect fail. Then take over, verify the app-server subtree pauses, verify input remains bounded to the shared schema, and return control. Test stopped-sandbox restart and explicit cleanup with the staging owner.
4. Before enabling token sharing, verify credential containment boundaries on the live desktop and stock app-server process tree: test the GUI's filesystem and `/proc` access against protected app-server, account, and supervisor locations; confirm the GUI cannot inspect the stock supervisor or read its environment/fds; and verify the desktop has no credential files or host/GUI environment injection. This proof has not been established on the target host; the historical host checks above and synthetic tests do not prove production containment. Record the operator review before setting `siwcSandboxVerified: true` in staging.
5. Only after step 4 passes, exercise unified ChatGPT setup and explicitly synchronize its managed access token. Trace the full route: broker `synchronizeToken` sends the bounded payload on stdin to `sbx exec ... server.mjs --sync-token`; the desktop proxy owns the private SIWC Unix socket; the proxy gives the stock supervisor an fd 3 bootstrap for `--stdio-token`; the token is held in supervisor/app-server memory and exposed to the stock app-server through its process environment. Confirm the token never appears in `sbx` or helper argv/environment, the SBX host environment, persistent files, GUI process/filesystem view, screenshots, typed input, or application logs. Then complete a successful authenticated inference request through the stock app-server. The desktop's native login must remain unavailable. If any token-specific containment check fails, disable the proof flag and keep the backend blocked.
6. Run owner-isolation and reconnect/revocation checks before admitting additional owners. Confirm ordinary web-session revocation prevents further viewer actions and lets the lease expire while the agent remains paused. Separately, disconnect the ChatGPT connection while takeover is paused and verify this credential revocation stops the VM without resuming the agent; a subsequent start must require an explicit, authorized action.

The adapter’s automated tests use a fake CLI to cover command construction, version rejection, strict config, binding-ledger behavior, non-TTY bridge I/O, bounded computer input, and token synchronization mechanics. These tests establish adapter logic only; they do not establish KVM availability, live CLI schema compatibility, image boot, SIWC token synchronization in a real SBX, authenticated model inference, or GUI credential containment. This deployment remains blocked and must not be described as ready until the live preflight passes and an operator records the proof that permits `siwcSandboxVerified` to be enabled.

Focused fake-CLI checks:

```sh
npx vitest run --project unit \
  tests/unit/personal-codex-sbx.test.ts \
  tests/unit/personal-codex-docker.test.ts \
  tests/unit/personal-codex-broker.test.ts
```

## Application and control behavior

Only enable `COMPUTER_VIEW_ENABLED=1` after the preflight. The web application also requires `AUTH_WEB_SESSION_REGISTRY_ENABLED=1` so every stream and input action can verify that the browser session has not been revoked. The **Computer** button appears for Codex conversations; unsupported Docker runtimes show an unavailable state. Opening the viewer never provisions or starts a runtime.

The desktop is account-owned: conversations using the same personal Codex account see the same computer and browser profile. It is not a separate machine for each bot. Each viewer resolves the owned conversation, current bot/app, account binding, and runtime again on the server. A browser cannot select a raw sandbox ID or socket path. The frame stream uses same-origin authenticated requests and bounded JPEG frames; no VNC, CDP, or app-server TCP port is published.

**Take over** durably records a pause, suspends the app-server process tree, and only then grants a 30-second input lease bound to the web session and conversation. The viewer renews that lease while open. Human input never implicitly resumes the agent: the user must explicitly **Return control**. A normal viewer close, lease expiry, or ordinary web-session revocation ends human input while leaving automation paused. Disconnecting the ChatGPT connection while takeover is paused stops the VM and does not resume the agent. Agent tools and new account operations are fenced while paused. The desktop keeps running during an active takeover so a person can sign into or verify independent websites; the ChatGPT connection is managed outside the desktop and is not authenticated through its GUI.

The GUI has a separate filesystem and PID namespace: account files, the private app-server socket, host process view, and Codex metadata are intended to be hidden. The stock app-server retains its existing permission profile. Trusted computer actions cross the protected broker socket; the agent's shell does not receive unrestricted X11 access. For SIWC, the runtime adapter passes a bounded token payload on stdin to the guest `--sync-token` helper, which forwards it over the desktop proxy's private SIWC Unix socket. The proxy stops existing stock-server sessions before rotating the credential in memory; each new stock supervisor receives a one-time fd 3 bootstrap for `--stdio-token`, then exposes the token to the stock app-server process environment. Credentials are not placed in GUI arguments, GUI environment, or persistent files. These are implementation properties to validate; actual GUI `/proc` and filesystem credential containment has not yet been demonstrated on live SBX.

The agent receives five bounded native app-server dynamic tools: screenshot, click, type, key, and scroll. Tool calls revalidate conversation access and the account/runtime binding; input is serialized with takeover at the broker. Chat activity records only the tool name and success, excluding typed text and image payloads. The pinned app-server accepts dynamic tool registration on `thread/start`, so start a new conversation after enabling the feature. An older retained thread does not acquire tools when resumed. Threads originally created with these tools retain them, but every call still needs current authorization and an available computer.

The [research note](../reviews/computer-view-research.md) links authentic Dots, Grok Bot, and Muse references. CollectiveUI uses the main unified SIWC-managed ChatGPT identity; third-party products' native sign-in details do not describe this implementation. The checked-in desktop/mobile screenshots use clearly labeled synthetic frame fixtures; they demonstrate layout, not a working microVM, authenticated inference, or credential containment.

## Development verification and limits

`node tests/browser/computer-transport.mjs` exercises the actual desktop Unix-socket proxy and bridge in an ephemeral, network-disabled Docker container with the real stock supervisor and a synthetic Codex executable. It checks two independent initialized transports, socket ownership/mode, Origin rejection, oversized messages, absence of a TCP listener, and socket cleanup. It does not exercise a logged-in Codex instance.

The desktop runtime and SIWC control sockets first become visible at their final paths
with mode `0600`. They bind in a private staging directory and use atomic hard-link
publication after permissions are confirmed, so a readiness poll cannot race a later
chmod. Publication never overwrites an existing listener. The disposable transport
fixture retains its immediate mode and ownership assertions.

`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium node tests/browser/computer-viewer.mjs` exercises the real viewer against fixture API responses, including takeover, expiry, sanitized input, reconnect, and delayed responses across conversation changes. It saves the labeled desktop/mobile screenshots.

This development host also blocks the nested namespaces needed for the GUI's bubblewrap/Chromium sandbox. A full desktop boot, headed browser, protected-file and `/proc` access attempts from the GUI, real SIWC synchronization, authenticated model inference, native agent tool execution, and KVM containment remain part of the staging preflight. No `--no-sandbox` fallback is supplied. Do not infer desktop, credential-isolation, or microVM readiness from the passing transport and UI fixtures.
