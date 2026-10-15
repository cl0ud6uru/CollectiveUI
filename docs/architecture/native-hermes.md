# Native Hermes connections

Native remote command discovery, supported commands and approval boundaries are documented in [Personal Remote Hermes commands](remote-hermes-commands.md).

## Scope and delivery

Personal remote connections belong to the signed-in user. Admin-managed shared backends and isolated managed/local runtimes remain separate. Administrators can disable personal remote access while retaining saved connections and allowing admitted turns to finish, receive prompt answers and stop. New work and new sign-ins are blocked. Cloudflare Access and a connection wizard are deferred.

This integration provides a native **remote dashboard workspace**, separate from Runs API chats and the managed/local controller. [Native settings and MCP administration](native-hermes-settings-mcp.md) and [read-only workspace inspection](native-hermes-workspace.md) are implemented as scoped panels. [Managed/local native chat controls](hermes-managed-local-parity.md) provide attachments and active-turn controls in ordinary bot chats; they do not share the remote dashboard workspace or its credentials.

## Available now

- Admin → Settings: **Allow personal remote Hermes connections**, off by default. Public dashboards require HTTPS. Private dashboard bases require explicit approval because requests originate from the portal server. DNS answers are validated and pinned for HTTP and WebSocket connections; metadata destinations and automatic redirects are blocked.
- **Allow confirmed session YOLO changes** is a separate administrator gate, off by default. On verified native runtimes, owners can confirm an explicit session on/off change from `/yolo` or Approval mode. The [command documentation](remote-hermes-commands.md) describes effective/inherited bypass, shared-client effects, compatibility and no-replay boundaries. Profile/process policy changes remain unavailable.
- Settings → Connected accounts: native username/password sign-in and dashboard session-token access. Password sign-in selects the single advertised password provider and exchanges a PKCE authorization code. Cookies remain scoped to the attempt. Passwords are not stored. Access/refresh tokens use row/owner-bound authenticated encryption and never enter UI projections or audit payloads. Sign-in verifies authenticated profile discovery before saving, and token rotation is serialized and committed before later requests can fail.
- **Open Hermes**: profile selection, native saved conversation browsing, new chats, native history, live assistant/tool output, native usage and context inspection. Local bindings retain both stored and runtime native identities. A connection uses one server-owned dashboard socket, negotiates readiness and server-request support, sends heartbeats and reconnects with session snapshots. The browser polls projected views; no dashboard credential is sent to the browser.
- Native attachments: images use `image.attach_bytes`, PDFs use `pdf.attach`, other files use `file.attach`. Failed staging attempts detach known staged images. Approval cards support allow-once/deny; clarification uses native question IDs; sudo, secret and vault prompts send protected values directly to their pending native request without storing them in portal transcripts. Active turns support steering, one queued message and interruption. Commands/skills are discovered from Hermes. Command results that request inference become composer prefills for an explicit send.
- Ownership is checked at every API operation. Prompt, queue and command receipts are written before dispatch. Snapshot reconciliation checks a durable revision so an older native snapshot cannot overwrite a newer admission. The single queue slot is reserved under the session row lock; unacknowledged queue outcomes remain reserved until native evidence confirms consumption. Request IDs bind late acknowledgements to their own reservations. Retrying a receipt does not replay work; conflicting content is rejected. Unconfirmed admission remains blocked until native activity/terminal evidence establishes its outcome. Disabling access is rechecked under the settings-row lock at final admission. Already admitted work retains answer/stop/recovery access; idle chats are not cold-resumed while access is disabled.

The sidebar **Hermes** entry opens an owner-scoped connection roster and recent chats, including active chats after admission is disabled. The workspace browses native conversations in 100-row pages and can import chats beyond the first page. Live snapshots show the latest 200 native transcript rows; **Load conversation history** fetches bounded 200-row native REST pages, suppressing hidden scaffolding and retaining display-only projections without inline attachment bytes. Older rows remain visible across polling updates. Browser reload recovery uses the portal session ID in the URL. Paging offsets follow native storage rows, including hidden entries; concurrent history changes can cause overlap, which the UI deduplicates by durable row identity. Older Hermes versions that lack native approval support fail closed; unsupported optional RPCs report the feature as unavailable. Definitively unsupported commands release their admission while retaining the receipt; uncertain command failures remain blocked. Chat/profile switches clear drafts, files and history state, and discard delayed responses from the departed selection, including when the same chat is selected again. Portal deployment must allow outbound WebSocket upgrades to the dashboard. Hubs live in the web process: use a single web instance or sticky routing for active native sessions until distributed hub ownership is implemented.

Conversation list offsets advance by the requested 100-row native window and use the native total to detect the last page. Hermes appends pinned chats outside that window; those remain selectable without consuming the next page's offset. Paged browsing is unavailable if the dashboard omits its pagination total, rather than guessing from pin backfill.

History requests include native compacted display rows, preserving earlier turns across in-place compaction while retaining the native exclusion of rewound rows. A history page must echo the requested latest order, 200-row limit and offset; missing or mismatched metadata reports history paging as unavailable. This prevents older dashboards that silently ignore the order parameter from presenting the oldest page as the conversation tail.

Native multimodal history retains recognized text blocks and image/audio markers while omitting attachment payloads, URLs and unknown fields from the browser projection. Older dashboard versions retain their native REST lineage limits, including versions that expose only the current compression segment.

## Credential and policy lifecycle

A successful manual sign-in at an existing owner/dashboard URL replaces the connection with a fresh local connection ID. The transaction retires the old connection and cascades its local session bindings and no-replay receipts; no old stored/runtime ID is transferred to the replacement account, even if both accounts advertise identical profile names. Native conversations on Hermes are not deleted. Reopen them through the replacement account's authenticated listing. Ordinary token refresh retains the connection identity. A failed replacement transaction leaves the previous connection and bindings intact.

After replacement commits, the web process eagerly closes the old socket and clears its cache. Old hub/socket references cannot reconnect. Other web processes discover retirement through a database ownership/identity check before every native RPC, native answer and cached view; no distributed invalidation broadcast is claimed. As before, hubs require a single web instance or sticky routing. In-flight work already dispatched cannot be recalled or replayed. A turn running under the retired account is not rebound to the replacement account; use that account's native dashboard for any remaining recovery.

Socket dispatch also reads the current organization policy, including for warm sockets and epoch-guarded setters. Private-destination revocation blocks all new prompts, uploads, steering, queues, commands, inspection and settings operations. The existing pinned socket may only resume or interrupt a durable, owned active binding, answer its server-verified pending interaction, or send its heartbeat. It cannot reconnect to a revoked destination. Idle, unrelated profile/session IDs and invented prompt/approval IDs are not recovery authorizations. Disabling admission without revoking the destination still allows admitted turns to reconnect, receive answers and stop. These checks do not revoke work already accepted by the remote Hermes server or provide distributed cancellation.

Regression coverage uses real loopback WebSockets for ready-socket revocation, cached identity fencing, setters/answers, recovery boundaries and reconnect behavior, plus PGlite executing migrations `0030`–`0032` to verify replacement with overlapping account profiles, active bindings, receipt cascades and unrelated-owner preservation. No additional migration, production policy change or real credential is required.

## Setup

Apply migrations `0030_remote_hermes_connections`, `0031_remote_hermes_sessions` and `0032_remote_hermes_reservations` using the normal deployment migration process. This implementation does not migrate the deployed database or publish/deploy the app.

These migrations follow the merged Live Activities migration `0029_live_activities`. Disposable databases that applied earlier, unmerged PR34 migration numbers must be rebuilt; a database that retained that preview schema needs a separate migration bridge before using this sequence.

1. Enable personal remote Hermes in Admin → Settings; approve a private dashboard base if required.
2. Sign in under Settings → Connected accounts → Remote Hermes.
3. Select **Open Hermes**, select a profile, then open an existing chat or create one.

Credentials, private server addresses and deployment overrides belong in runtime configuration, not the public repository. Examples and tests use synthetic credentials and reserved example domains.

## Validation

Unit checks cover password/PKCE exchange, native token decoding and refresh, credential projections, owner-bound encryption, pinned transport, readiness/capabilities, reconnect without prompt replay, question IDs, snapshot projections, ownership, disablement during admission and continuation after disablement. Existing Hermes provider/provisioning checks also pass.

`npm run test:hermes-ui` uses the real workspace component with an isolated synthetic HTTP fixture and headless Chromium. It checks history, live response, attachment submission, approvals, clarification, protected prompts, steering, queueing, disablement, stop and profile switches with draft/file cleanup and stale response rejection. It does not exercise real dashboard authentication or replace a live Hermes compatibility check.

`tests/integration/remote-hermes.test.ts` and `tests/integration/remote-hermes-reservations.test.ts` check real database identity/receipt constraints, owned bindings, fixture cascade cleanup, queue reservation contention, revision reconciliation, unknown queue recovery and late acknowledgements. It runs only when `REMOTE_HERMES_INTEGRATION=1` and `DATABASE_URL` points to a disposable database named `hermes_fixture`; never set these to production. All migrations have been checked against a disposable pgvector/Postgres database. A real remote Hermes server has not yet been used for end-to-end verification.

### Reservation fixture evidence (issue #97, partial)

The reservation socket is **synthetic** and implements `callWithEpoch`: it captures the epoch at RPC dispatch, including when a reply is delayed across a simulated reconnect. The suite checks that the hub retains that dispatch epoch and updates it on the next resume, alongside the database reservation/race assertions. This is not evidence of real dashboard transport or live runtime compatibility.

To repeat the database checks, migrate a **disposable** pgvector/PostgreSQL database named `hermes_fixture`, then run:

```sh
REMOTE_HERMES_INTEGRATION=1 DATABASE_URL="$FIXTURE_DATABASE_URL" \
  npm test -- --project integration \
  tests/integration/remote-hermes-reservations.test.ts \
  tests/integration/remote-hermes-rewrap.test.ts
```

Verified fixture identity: `pgvector/pgvector:pg17`, image digest `sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d`, PostgreSQL 17.11 on x86_64 Linux. The two suites passed 8 tests against a freshly migrated disposable database. No Hermes dashboard was launched or contacted, and no production credentials or inference were used. Real pinned-dashboard auth/refresh, attachments, prompts, reconnect/stop, history and reservations remain unverified; the live conformance portion of #97 remains open.

## Remaining work

- Extend the implemented managed/local controls to additional native command/settings/MCP/workspace operations where supported; shared remote Runs backends retain their separate behavior.
- Extend the existing remote settings/MCP panel to model/provider selection, credential pools, OAuth and further MCP lifecycle operations.
- Extend read-only workspace inspection to authorized file content and mutating project/schedule/plugin operations. Existing project, directory, schedule, plugin and system panels remain metadata-only. Profile names are not tenant security boundaries.
- Implement distributed hub ownership before multi-instance deployment; the sidebar roster and paged remote history are now implemented. Native remote chats remain distinct from Runs API conversation records and bot homes.

References reviewed: Vory `622c9b41d1fcb2cee3564a328c11cd72cff7ee18` and Hermes native contracts at `79af3f6cea8067284a7ea5725078578b3f790adb`. No real credentials or private deployment configuration are included.

### Prompt answer delivery (issue #91)

Native JSON-RPC responses do not have a second acknowledgement. The socket waits
for its write callback (or rejects on write failure, close, or a 30-second deadline)
and fences the response to the socket epoch that supplied the pending request.
A successful write means **sent**, not native acceptance. After sending, the hub
drains any earlier refresh and reads a fresh snapshot. The answer API returns
`{ sent: true, status: "pending" | "resolved" | "uncertain" }`: `resolved` means the
native prompt is absent, which can also result from cancellation or another
client. It does not certify that the protected value was used or an approved
command executed. `uncertain` means the post-send snapshot failed.

The hub reserves an answer before dispatch and keeps only a delivery marker on
the pending prompt. Snapshot polling, repeated request frames and reconnection
preserve that marker while the same request remains open. An attempted answer
cannot be submitted again through that hub; the UI shows delivery status and
removes its answer controls. A failed write retains an uncertain marker and
reconciles without replaying the response. Values are never persisted, hashed,
added to transcript projections or retained for retry. Allow-once/deny validation
is unchanged. Approval snapshots that require `approval.respond` use the same
socket-epoch fence and fresh-snapshot settlement.

These markers are process-local, as are the socket's native request routes. They
are not distributed answer receipts. A process restart or another portal replica
can recover an open prompt only through native `session.resume`; this integration
does not automatically resend any prior answer. Inspect the native dashboard if
delivery remains uncertain. Stronger exactly-once confirmation across replicas
requires a verified native receipt contract and the distributed ownership work
in #96.

Focused regressions cover held write callbacks, write errors, disconnect during
write, stale socket epochs, concurrent answers, still-open prompts, resolved
prompts, failed post-send snapshots and marker recovery without protected-value
retention. Transport tests use real loopback WebSockets; hub tests use synthetic
native snapshots and database boundaries. No real pinned dashboard compatibility
or live authentication is established by these tests.

### Owner removal and disconnect (#89)

Settings → Connected accounts → Remote Hermes provides **Remove connection**, even
when personal remote admission is disabled. The confirmation explains that local
credentials, conversation links and submission receipts are deleted. Native
conversations remain on Hermes, and active/queued work can continue there. This
operation does not interrupt native work or revoke an upstream token/sign-in;
use verified native account controls separately for that. No upstream revocation
API is assumed or called.

The server derives the owner from the authenticated principal and checks the
mutation origin. Preview returns only the count of linked active/queued/uncertain
portal sessions, not native IDs or credentials. Removal repeats that check under
policy → owned connection → session locks. Active, waiting, admitting, uncertain
or reserved queue work requires a separate checkbox confirmation. If work became
active after an idle preview, the first removal attempt returns a fresh count
without deleting anything. Counts describe linked portal state, not all work in
other native clients.

Credential-row deletion, cascading local bindings/receipts and the safe removal audit are atomic. Failed
transactions, including failed audit inserts, leave the hub usable and local records intact. Only after commit
does the current process retire its socket/hub; the closed socket reference and
its authentication URL are released. Existing durable identity checks fence old
references and other processes before their next dispatch/view. No distributed
broadcast or recall of already-dispatched operations is claimed. Database/backups
follow their normal retention policy; this is logical credential deletion, not a
claim of storage-media zeroization. Reconnecting creates a fresh authorization
identity and independently discovers retained native conversations.

PGlite regressions execute migrations 0030–0032 and prove owner isolation,
credential/binding/receipt cascades, all durable active states, activity appearing
after preview, disabled-admission removal, rollback and post-commit retirement.
Action tests prove principal/origin binding and honest audit outcomes. A real
loopback WebSocket test verifies retired socket-reference release and no
reconnection. Browser/assistive-technology validation and real-dashboard
revocation are not established by these checks. No real connection was removed.

### Transport trust and authentication URL diagnostics (#99, partial)

Private-address approval permits the portal to route to a dashboard. It does not
prove encryption, including for LAN, loopback, container or VPN-looking names.
The connection form and saved HTTP connections now display that HTTP is not
encrypted, that administrator approval does not encrypt it, and that passwords,
tokens and protected replies can be exposed unless a separately verified tunnel
protects the route. The administrator hint makes the same distinction. HTTPS
remains the public-address requirement and the connection-form example. This
change does not alter enabled policy, private approvals or trusted tunnels.

Invalid base URLs and malformed native sign-in callback URLs now become bounded
application errors without retaining Node's raw `input` URL property. Unexpected
socket target/upgrade errors are replaced by a generic error without a raw cause;
typed policy/authentication errors keep their deliberate messages. No token,
ticket, authorization code, state, credential or callback URL is logged by these
paths. Four regressions failed before these changes; eight disclosure/error tests
now cover private/loopback HTTP warnings, disabled-admission saved connections,
invalid URL diagnostics, socket-target failures and malformed native callbacks.
The lifecycle fixture now uses the same typed policy error as production.

WebSocket authentication still uses the verified native ticket path
for password/OAuth access, and the native session-token query mode for dashboard
session tokens. No ticket-exchange API for session-token mode is assumed. Because
an authentication query must reach Hermes, application error sanitization cannot
remove it from reverse-proxy, tunnel or upstream access logs. Those operators
must omit query strings and redact `token`, `ticket`, `code`, `state` and
`code_verifier`, plus Authorization/Cookie headers, from logs and diagnostics.
Never paste actual upgrade or callback URLs into issues or documentation.

Remaining implementation/acceptance work: choose and encode an explicit verified
TLS/tunnel trust policy for approved private HTTP without blindly breaking trusted
tunnels; verify any additional short-lived credential exchange against pinned
runtime capability; and validate external proxy/upstream log handling. No proxy
configuration, live transport policy, credential exchange/grant, paid inference
or production deployment was changed or exercised here. These unit/SSR and
loopback checks do not establish live encrypted transport or log-system hygiene.
