# Optional local computer view with Docker Sandboxes

**Deployment status: disabled pending an on-host v0.48.0/KVM preflight.** The adapter has fake-CLI coverage, but this development host has no usable `/dev/kvm` and the local `sbx` daemon cannot start. Its live `sbx inspect` payload, resource fields, digest semantics, and desktop image boot have not been verified here. Keep the existing Docker backend enabled until the preflight below passes on a supported Linux host.

This backend is opt-in. The broker still uses the existing protected Unix socket and stock Codex app-server bridge. Native `account/login/start`, `account/read`, and `account/logout` continue to run inside the owner’s sandbox. The adapter does not replace account authentication with SIWC, add a provider, or pass API tokens to the `sbx` command line or environment.

## Build and pin the desktop image

Start with the operator-reviewed personal Codex runtime image by immutable digest. Build the desktop variant from the repository root; the image keeps `/opt/collective-codex/server.mjs` and adds the private desktop/control files from `docker/computer/`.

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
  "memoryMb": 4096,
  "cpus": 2
}
```

`sbxExecutable` may be `/usr/local/bin/sbx` or `/usr/bin/sbx`; `sbxVersion` must be `0.48.0`. `memoryMb` is an integer from 512 through 65536, and `cpus` is an integer from 1 through 64. The config schema rejects extra fields. In particular, it has no hook, kit, shared-skill, secret, host-path, or credential settings.

The backend selector defaults to Docker when omitted, preserving existing deployments and their Docker config. To roll back, restore the existing Docker configuration (omit `backend` or set it to `docker`) and restart the broker. Do not delete owner sandboxes or their ledgers as part of a backend switch; use the explicit cleanup path after reviewing the data-retention impact.

## Required live preflight before enabling

Use a staging broker and one disposable admitted owner first. A fake CLI test is not a substitute for this gate. Confirm all of the following on the target Linux/KVM host with the exact pinned CLI and desktop image:

1. The `sbx` daemon is healthy, `/dev/kvm` is available to it, the reviewed digest is in the local image store, and a no-workspace sandbox starts with the configured CPU/memory limits.
2. Capture the actual `sbx ls --format json` and `sbx inspect --format json <staging-name>` structures locally. Verify the immutable ID, image digest meaning, state, empty workspace/mounts/kits/secrets/published ports, SSH forwarding status, and recorded CPU/memory fields match what the adapter validates. The adapter deliberately rejects unknown or incomplete inspect data. Do not weaken the validator to accommodate a schema until the v0.48.0 output has been reviewed.
3. Keep an app-server bridge open while requesting screenshots and computer input. Confirm a healthy active `sbx exec` session does not make routine inspect fail. Then take over, verify the app-server subtree pauses, verify input remains bounded to the shared schema, and return control. Test stopped-sandbox restart and explicit cleanup with the staging owner.
4. Complete native Codex device login and a successful authenticated model request through the existing app-server flow. Confirm credentials and typed input never appear in host command arguments or application logs. Frames are delivered only to the authorized viewer and native agent tool response.
5. Run owner-isolation and reconnect/revocation checks before admitting additional owners.

The adapter’s automated tests use a fake CLI to cover command construction, version rejection, strict config, binding-ledger behavior, non-TTY bridge I/O, and bounded computer input. These tests establish adapter logic only; they do not establish KVM availability, live CLI schema compatibility, image boot, account login, model inference, or containment. This deployment remains blocked until the live preflight passes.

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

**Take over** durably records a pause, suspends the app-server process tree, and only then grants a 30-second input lease bound to the web session and conversation. The viewer renews that lease while open. Closing it, switching conversations, losing the connection, or lease expiry ends human input while leaving automation paused. Reopen the original conversation, or wait for the old lease to expire, then take over and explicitly **Return control**. Agent tools and new account operations are fenced while paused. The desktop keeps running so a person can complete a sign-in or verification.

The GUI has a separate filesystem and PID namespace: account files, the private app-server socket, host process view, and Codex metadata are hidden. Native Codex retains its existing permission profile. Trusted computer actions cross the protected broker socket; the agent's shell does not receive unrestricted X11 access. The desktop image relays stock app-server JSON-RPC over a protected Unix socket and retains the existing native login flow.

The agent receives five bounded native app-server dynamic tools: screenshot, click, type, key, and scroll. Tool calls revalidate conversation access and the account/runtime binding; input is serialized with takeover at the broker. Chat activity records only the tool name and success, excluding typed text and image payloads. The pinned app-server accepts dynamic tool registration on `thread/start`, so start a new conversation after enabling the feature. An older retained thread does not acquire tools when resumed. Threads originally created with these tools retain them, but every call still needs current authorization and an available computer.

The [research note](../reviews/computer-view-research.md) links authentic Dots, Grok Bot, and Muse references. The checked-in desktop/mobile screenshots use clearly labeled synthetic frame fixtures; they demonstrate layout, not a working microVM or authenticated agent session.

## Development verification and limits

`node tests/browser/computer-transport.mjs` exercises the actual desktop Unix-socket proxy and bridge in an ephemeral, network-disabled Docker container with a synthetic stock-server replacement. It checks two independent initialized transports, socket ownership/mode, Origin rejection, oversized messages, absence of a TCP listener, and socket cleanup. It does not exercise a logged-in Codex instance.

`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium node tests/browser/computer-viewer.mjs` exercises the real viewer against fixture API responses, including takeover, expiry, sanitized input, reconnect, and delayed responses across conversation changes. It saves the labeled desktop/mobile screenshots.

This development host also blocks the nested namespaces needed for the GUI's bubblewrap/Chromium sandbox. A full desktop boot, headed browser, protected-file access attempts inside the GUI, native agent tool execution, and KVM containment remain part of the staging preflight. No `--no-sandbox` fallback is supplied. Do not infer desktop or microVM readiness from the passing transport and UI fixtures.
