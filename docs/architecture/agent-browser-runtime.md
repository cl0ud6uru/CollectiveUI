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

The parent-approved integration consumes W5 PR #181 at `0b5ff7b56b445962a91d4674ab919b28eb614638`,
W2 PR #182 at `d2547bcaff4d2faf83e73bf823cfbb07b2a7ca10`, and the personal-Codex migration 0055
ancestry, including owner recovery fix `57b9266bb8280a8e80a6de7fe4edd2a4a9a47114`
after settings fixture fix `b805513984f4c43bcfe833d49b54aa00cec37007`.
`instrumentation.ts` registers the W4 resolver at web startup; `toolset.ts` installs the
`agent_browser` group and its close callback. `native-integration.ts` resolves the real W2 binding with
`createIfMissing:false` and rechecks it on every agent operation. W5's source selector uses that same
binding; it never provisions a browser/workspace during viewing or falls back across instances.

`integration.ts` rechecks the signed request's durable web-session record, fresh principal, usable bot,
configured browser tool group, direct owned conversation/run and selected private instance on EVERY
source/status/frame poll. Additive migration `0056_web_sessions` stores a domain-separated SHA-256
session identifier, owner/version, fixed absolute expiry and revocation time; it stores no JWT/cookie.
Set `AUTH_WEB_SESSION_REGISTRY_ENABLED=1` only after installing that migration. This prerequisite is
checked before browser source registration. Registry admission never revives tombstones or extends
expiry; bounded cleanup removes only expired rows. HTTP logout validates origin, original signed
cookie and Auth.js CSRF proof; server-action logout decodes the original signed cookie. Both commit
revocation before Auth.js clears cookies. DB failure preserves retry cookies, including at the auth
proxy, while successful renewal preserves the complete cookie-chunk cleanup/replacement bundle.
An already-open stream cannot use its original request cookie to override logout; source failure
errors the SSE stream and discards queued bytes. Frames already delivered to a client cannot be recalled.

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

## Authorized native registration

Call `agentBrowserTools(ctx, { workspace, assertWorkspace, registerSource, unregisterSource })` from the
`agent_browser` tool group in the parent's small `toolset.ts` integration. Add the group to the builtin
tool list through its existing catalog/editor policy, preserve configured approval modes, and register
the returned close callback. Navigate/act are sensitive and non-grantable. The first adapter admits
only direct native durable caller runs; it rechecks enabled user, workspace audience, bot, conversation,
run/holder/cancellation and configured tool group on every call. Delegated, group, service, Hermes and
Codex runs are unsupported. W2 supplies an ownership-checked instance plus a revalidation closure;
without W2 use null for the explicit per-owner browser. Parent-authorized shared hooks and migration
0056 are confined to the integration branch; foundation/Codex 0054/0055 files are unchanged. Browser execution depends on `playwright-core@1.63.0` in the broker's independent package;
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
Browser-control and egress sockets are bound inside an owner-only staging directory,
confirmed as mode `0600`, then atomically hard-linked to their configured paths.
Startup fails if permissions or no-replacement publication cannot be established;
the socket filesystem must support hard links. Closing removes only the published
socket with the same filesystem identity, preserving a replacement at that path.

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

- Full unit suite passes: 223 files, 2,681 tests; four files / 16 tests skip under their existing gates.
  Full TypeScript check passes after a clean locked `npm ci`; changed-file ESLint passes.
- Provider/admission tests cover scope spoofing, current principal/version/bot/tool/workspace policy,
  cancellation, signed transport, pinned DNS and blocked redirect/network policy.
- Six actual Chromium fixtures use synthetic pages and verify navigation/click JPEG pixels, separate
  owner processes/cookies, redirects/HttpOnly cookies, embedded documents, request bodies and cleanup.
- Joint fixture `tests/sandbox/agent-browser-viewer-integration.test.ts` uses actual native tools,
  the broker, production viewer authorization, W5 resolver/SSE and real PGlite registry. Another Node
  process discovers the same Page. Two simultaneous viewer windows stop after real signed logout,
  queued frames are discarded, replayed old-cookie status fails, and the agent browser remains active.
- Registry/logout tests exercise races, replay, another login, cross-user denial, fixed expiry/cleanup,
  account revocation and DB outages. Migration test preserves 0054 workspace and 0055 Codex records,
  verifies snapshot ancestry/constraints and migrator rerun. All 57 migrations applied twice in a
  disposable PostgreSQL 16 container; mobile auth and W2 migration/binding/pool-lock regressions passed (22 tests).
- Actual Chromium fixtures use explicit `AGENT_BROWSER_TEST_UNSANDBOXED=1` through injected test
  launchers because this host's Chromium sandbox helper is misconfigured. Production always enables
  the Chromium sandbox. Functional evidence is not proof of production containment.
- A disposable nonroot/read-only/cap-drop/network:none/resource-bounded container reports only
  loopback interfaces. Production browser image build is blocked by Docker DNS to Debian package
  servers; sandbox-enabled Chromium and final operator-reviewed socket/egress containment are unverified.

Run focused unit tests with `npm test -- --project unit tests/unit/agent-browser-provider.test.ts
 tests/unit/agent-browser-admission.test.ts tests/unit/web-session-revocation.test.ts
 tests/unit/web-session-migration.test.ts tests/unit/web-logout-boundary.test.ts
 tests/unit/web-logout-wiring.test.ts tests/unit/agent-browser-viewer.test.ts`.
Run real synthetic page fixtures with `AGENT_BROWSER_RUNTIME_TEST=1 AGENT_BROWSER_VIEWER_PROOF=1
 npm test -- --project sandbox tests/sandbox/agent-browser-runtime.test.ts
 tests/sandbox/agent-browser-viewer-integration.test.ts`. The unsandboxed flag is a fixture-only override.

Before release, an operator must build and validate the sandbox-enabled image, namespace support,
private socket permissions, separate egress service and resource limits using the
[operator test checklist](agent-browser-operator-checklist.md). The combined worker uses the owner
Codex recovery patch; plain Node imports and browser-bundle rejection are regression-tested.
W4 excludes Codex execution. Then install approved migration
0056 and explicitly enable both opt-ins. No deployment, migration against a live database, runtime-owned
credential action or production security/configuration change was performed. `agentBrowserView`
template capability remains false pending production provider admission and review.
