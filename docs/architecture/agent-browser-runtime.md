# Private agent browser runtime (W4)

Opt-in implementation for contract `72dc843`. Existing sandboxd, file browser, template capabilities,
native Codex and external Hermes paths are unchanged. This is a separate browser runtime, not shell egress.

## Consumer contract (W5 / parent)

`src/lib/agent-browser/provider-contract.ts` exports `AgentBrowserProvider`, `BrowserScope`, strict
`BrowserAction`, `BrowserInspection`, and `BrowserFrame`. Scope contains server-admitted
`ownerUserId, botId, runId, conversationId, workspaceInstanceId`. Null instance means a deliberately
owner-bound browser workspace; it is never a global session. Open is idempotent for that entire tuple.

`PrivateBrowserProvider` uses authenticated private Unix-socket requests. The worker opens a session;
the web process constructs its own provider in `view` mode with a **viewer-specific authorization callback**, calls
`find(scope)`, then `browserSource(provider, scope, sessionId)` from `sessions.ts`. Lookup, status and
frame subscription do not allocate a browser. W5 owns `session-source.ts` and public API/DTO encoding.
The runtime source is `{ ...scope, sessionId, status(), subscribeFrames(signal) }`; it has no input method.
The factory's optional register/unregister callbacks are the runtime-side source registration hook.
In-memory registration alone cannot cross a worker/web process boundary; use daemon lookup.

For W5 PR #181 at exact `0b5ff7b56b445962a91d4674ab919b28eb614638`, import W4
`installBrowserSessionSourceResolver` from `viewer-source-adapter.ts` and pass W5's
`registerBrowserSessionSourceResolver` plus a server authorization callback. This matches W5's
`(scope, signal) => source | null` and `source.status(signal)` shapes without changing W5-owned files.
The callback returns the full W4 scope, deriving conversationId from the persisted owned run and
verifying the actual W2 instance binding every time. W5 currently builds a null instance selector;
template integration must derive the real binding or reject the mismatch. No fallback across instances.

The viewer authorization callback must also enforce **server-side logout/session-end revocation**.
PR #181's current Auth.js JWT checks, 30-second streams and unmount abort do not provide that guarantee:
an already-open request retains its original cookie. W4 deliberately has no permissive default viewer
authorization callback. Keep viewer/runtime opt-in disabled until the auth owner supplies and tests
that guarantee. Synthetic callback revocation proves the adapter stops frames; it cannot prove that
actual logout triggers the callback's denial.

Status provider method returns `active | idle | disconnected`; broker status includes
`{ state, viewOnly: true, lastFrameAt: string | null }`. A missing source / failed status request means
disconnected. Frames are `{ sequence, capturedAt, contentType: 'image/jpeg', bytes: Uint8Array,
width: 1024, height: 640 }`. Public encoding is W5-owned. At most 256 KiB, one capture/sec, two subscriber
leases per session. Captures call screenshot on the exact tool-controlled Page. No extra demo page.
Subscription reauthorizes every poll, expires after five minutes, supports cancellation and frees its
lease without closing the agent page. A paused consumer loses its lease after ten seconds. Frames are
ephemeral and have no replay storage. Display disconnected after stale/failed capture, never “live”.

Internal signed POST endpoints (not public Next routes):

| Path | Body in addition to server-created `scope` | Result |
| --- | --- | --- |
| `/v1/browser/open` | none | `{ sessionId }` |
| `/v1/browser/find` | none | `{ sessionId: string \| null }` |
| `/v1/browser/sessions/:id/navigate` | `url` | `{ title }` |
| `.../inspect` | none | `{ text, elements: [{ ref, role, name }] }` |
| `.../act` | strict `action` | `{}` |
| `.../status` | none | status above |
| `.../subscribe` | none | `{ leaseId }` |
| `.../frame` | `leaseId` | JPEG with metadata JSON in `x-agent-browser-frame` |
| `.../unsubscribe` | `leaseId` | `{}` |
| `.../close` | none | `{}` |

Every request signs method/path/body/time/nonce using a dedicated `AGENT_BROWSER_SECRET`, and every
session operation compares the complete immutable binding. No arbitrary headers, cookies, proxy,
CDP URLs, scripts, filesystem paths or owner selectors in tool inputs. Viewer routes must authenticate
their principal, own conversation/run, current usable bot, current workspace binding and view policy;
they supply the callback, never trust selectors as authorization. Viewing does not grant tool admission.

## Parent-owned registration

Call `agentBrowserTools(ctx, { workspace, assertWorkspace, registerSource, unregisterSource })` from the
`agent_browser` tool group in the parent's small `toolset.ts` integration. Add the group to the builtin
tool list through its existing catalog/editor policy, preserve configured approval modes, and register
the returned close callback. Navigate/act are sensitive and non-grantable. The first adapter admits
only direct native durable caller runs; it rechecks enabled user, workspace audience, bot, conversation,
run/holder/cancellation and configured tool group on every call. Delegated, group, service, Hermes and
Codex runs are unsupported. W2 supplies an ownership-checked instance plus a revalidation closure;
without W2 use null for the explicit per-owner browser. No root package/schema/toolset edits are made
in W4. Browser execution depends on `playwright-core@1.63.0` in the broker's independent package;
the portal transport has no Playwright runtime import. Parent owns any shared package integration.

## Isolated infrastructure, disabled by default

Build the isolated image with `docker build -f docker/agent-browser/Dockerfile -t collective-browser:w4 .`.
The broker entrypoint requires `AGENT_BROWSERD_ENABLED=1`, `AGENT_BROWSERD_ISOLATION=network-none`,
a non-root uid and no non-loopback interface. Run with `--network none`, read-only rootfs, bounded
CPU/memory/PIDs, private tmpfs for `/tmp` and the non-root home, and private Unix socket directories
owned by the runtime uid. Keep Chromium sandbox enabled; a host runtime/seccomp profile must allow
its user namespaces. Do not grant privileged/SYS_ADMIN, use host IPC/network, mount Docker socket,
mount account homes, or publish ports. The implementation has no TCP/CDP listener or browser inputs.

Run `node src/agent-browserd/egress.ts` in a **separate** networked process/container with only its
private egress Unix socket shared with the broker. Supply separate random secrets to browser control
and egress; never reuse or mount SANDBOXD_SECRET. Paths are `AGENT_BROWSER_SOCKET` and
`AGENT_BROWSER_EGRESS_SOCKET`; secrets are `AGENT_BROWSER_SECRET` and `AGENT_BROWSER_EGRESS_SECRET`.
Portal opt-in requires `AGENT_BROWSER_ENABLED=1`, the control socket and browser secret in web/worker.
No production configuration is enabled here. Socket mount/permissions and namespace support need an
operator-reviewed deployment; no compose/security settings or live credentials are modified.

Chromium runs one process/context per private owner/workspace run, with ephemeral cookie/profile
storage. Cookies persist across that run's tools only; no cross-run login persistence is implemented.
Private Chromium Fetch interception brokers every HTTP(S) redirect hop through egress; WebSockets/service workers/popups/downloads
and password/file inputs are blocked. The kernel network boundary catches requests that bypass
routing (WebRTC, background traffic etc). Egress checks each redirect Location and subsequent
request, rejects private/reserved/mapped/metadata/mixed DNS answers and URL credentials, accepts
ports 80/443 only, pins the public IP per connection and preserves TLS hostname validation. Responses
must use identity encoding; compressed-only sites are unsupported. Request body 1 MiB, response
4 MiB, headers 16 KiB, eight concurrent requests per session, 32 egress requests globally, bounded
timeouts and cancellation. Chromium preserves the original request origin/cookie behavior. CDP uses
the private process pipe only; there is no debugger TCP port or externally selectable CDP endpoint.
Streaming/unknown-length/omitted, multipart and binary request bodies are rejected. Only bounded
plain-text, JSON and URL-encoded bodies already exposed by Chromium are accepted; no full-body CDP fetch.

At most eight browser processes, two per owner and one run per owner/workspace. Five minutes without
agent tools closes the process, even with viewers. Graceful shutdown kills processes; restart loses
all live bindings and frames. Private tmpfs removes abandoned profiles at container teardown. Viewer
never extends agent lifetime. No claim of GUI Office, sandbox workspace equivalence, or production
availability: `agentBrowserView` template capability stays false pending provider admission and review.

## Verified evidence and remaining gates

- 83 focused unit/regression tests pass: browser provider/admission plus existing sandbox policy,
  signing protocol and workspace-browser tests. Scope spoofing, refreshed principal/session version,
  current bot/tool/workspace admission, cancellation, egress pinning and blocked redirect policy covered.
- Six actual Chromium tests pass with synthetic routed pages: native tool navigation/click changes
  decoded same-page JPEG pixels; separate owner browser processes/cookies; same-origin HttpOnly cookie
  forwarding and cross-origin redirect isolation; embedded documents; cancellation; small text POST
  forwarding and oversized generated POST rejection; resource/idle/restart cleanup.
- Joint W4/W5 fixture `tests/sandbox/agent-browser-viewer-integration.test.ts` passes against exact
  W5 head above. Actual native tools -> private broker -> separate view-only provider -> W5 resolver
  and actual SSE route -> changed JPEG pixels. Viewer cancel preserves the agent browser; synthetic
  source revocation stops frames. No fabricated frame generator in this proof.
- Fixtures use explicit `AGENT_BROWSER_TEST_UNSANDBOXED=1` only via injected test launchers because
  this host's Chromium setuid helper is misconfigured. Production code always enables Chromium sandbox.
  Functional proof is not a production containment claim. Native Node TypeScript daemon import passes.
- A disposable `node:22-slim` container with uid 1000, read-only rootfs, network:none, cap-drop ALL,
  memory/CPU/PID limits reports loopback interfaces only. This proves that isolated test configuration,
  not the unbuilt browser image. Browser image build is blocked by Docker DNS for Debian package servers.
- Full TypeScript check has exactly the same diagnostics as clean main in this workspace: missing
  installed `three` and dependent voice/avatar type errors. Changed paths lint clean; no new diagnostics.

Run unit tests with `npm test -- --project unit tests/unit/agent-browser-provider.test.ts
tests/unit/agent-browser-admission.test.ts tests/unit/sandbox-policy.test.ts
tests/unit/sandboxd-protocol.test.ts tests/unit/workspace-browser.test.ts`.
Run real-page fixtures with `AGENT_BROWSER_RUNTIME_TEST=1 npm test -- --project sandbox
tests/sandbox/agent-browser-runtime.test.ts`; the explicit unsandboxed test flag is only for the
synthetic host fixture when necessary and never applies to the production entrypoint.
Run joint proof in an isolated worktree containing this W4 branch plus exact W5 head with
`AGENT_BROWSER_VIEWER_PROOF=1 npm test -- --project sandbox tests/sandbox/agent-browser-viewer-integration.test.ts`.

Before release: parent registers native tool group/closers and startup source resolver; W2/W5 resolve
actual private instance selectors; auth owner proves logout/session-end revocation; operator builds
and validates the sandbox-enabled browser container, socket permissions, egress separation and limits.
No deployment, shared migration, runtime-owned credentials or production security setting changed here.
