# Native Hermes connections

## Scope and delivery

Personal remote connections belong to the signed-in user. Admin-managed shared backends and isolated managed/local runtimes remain separate. Administrators can disable personal remote access while retaining saved connections and allowing admitted turns to finish, receive prompt answers and stop. New work and new sign-ins are blocked. Cloudflare Access and a connection wizard are deferred.

This first delivery provides a native **remote dashboard workspace**. It does not replace the existing Runs API chat or the managed/local controller. Further managed/local integration and native administration panels remain follow-up work, rather than exposing arbitrary dashboard endpoints through the portal.

## Available now

- Admin → Settings: **Allow personal remote Hermes connections**, off by default. Public dashboards require HTTPS. Private dashboard bases require explicit approval because requests originate from the portal server. DNS answers are validated and pinned for HTTP and WebSocket connections; metadata destinations and automatic redirects are blocked.
- Settings → Connected accounts: native username/password sign-in and dashboard session-token access. Password sign-in selects the single advertised password provider and exchanges a PKCE authorization code. Cookies remain scoped to the attempt. Passwords are not stored. Access/refresh tokens use row/owner-bound authenticated encryption and never enter UI projections or audit payloads. Sign-in verifies authenticated profile discovery before saving, and token rotation is serialized and committed before later requests can fail.
- **Open Hermes**: profile selection, native saved conversation browsing, new chats, native history, live assistant/tool output, native usage and context inspection. Local bindings retain both stored and runtime native identities. A connection uses one server-owned dashboard socket, negotiates readiness and server-request support, sends heartbeats and reconnects with session snapshots. The browser polls projected views; no dashboard credential is sent to the browser.
- Native attachments: images use `image.attach_bytes`, PDFs use `pdf.attach`, other files use `file.attach`. Failed staging attempts detach known staged images. Approval cards support allow-once/deny; clarification uses native question IDs; sudo, secret and vault prompts send protected values directly to their pending native request without storing them in portal transcripts. Active turns support steering, one queued message and interruption. Commands/skills are discovered from Hermes. Command results that request inference become composer prefills for an explicit send.
- Ownership is checked at every API operation. Prompt, queue and command receipts are written before dispatch. Snapshot reconciliation checks a durable revision so an older native snapshot cannot overwrite a newer admission. The single queue slot is reserved under the session row lock; unacknowledged queue outcomes remain reserved until native evidence confirms consumption. Request IDs bind late acknowledgements to their own reservations. Retrying a receipt does not replay work; conflicting content is rejected. Unconfirmed admission remains blocked until native activity/terminal evidence establishes its outcome. Disabling access is rechecked under the settings-row lock at final admission. Already admitted work retains answer/stop/recovery access; idle chats are not cold-resumed while access is disabled.

The workspace shows the latest 200 native transcript rows, with bounded display lengths. Browser reload recovery requires reopening the workspace URL carrying its portal session ID. Older Hermes versions that lack native approval support fail closed; unsupported optional RPCs report the feature as unavailable. Definitively unsupported commands release their admission while retaining the receipt; uncertain command failures remain blocked. Profile switches clear the active conversation and draft, and discard responses from the previous selection. Native history browsing preserves pinned backfill beyond the requested recent page within bounded response limits. Portal deployment must allow outbound WebSocket upgrades to the dashboard. Hubs live in the web process: use a single web instance or sticky routing for active native sessions until distributed hub ownership is implemented.

## Setup

Apply migrations `0029_remote_hermes_connections`, `0030_remote_hermes_sessions` and `0031_remote_hermes_reservations` using the normal deployment migration process. This implementation does not migrate the deployed database or publish/deploy the app.

1. Enable personal remote Hermes in Admin → Settings; approve a private dashboard base if required.
2. Sign in under Settings → Connected accounts → Remote Hermes.
3. Select **Open Hermes**, select a profile, then open an existing chat or create one.

Credentials, private server addresses and deployment overrides belong in runtime configuration, not the public repository. Examples and tests use synthetic credentials and reserved example domains.

## Validation

Unit checks cover password/PKCE exchange, native token decoding and refresh, credential projections, owner-bound encryption, pinned transport, readiness/capabilities, reconnect without prompt replay, question IDs, snapshot projections, ownership, disablement during admission and continuation after disablement. Existing Hermes provider/provisioning checks also pass.

`npm run test:hermes-ui` uses the real workspace component with an isolated synthetic HTTP fixture and headless Chromium. It checks history, live response, attachment submission, approvals, clarification, protected prompts, steering, queueing, disablement, stop and profile switches with draft/file cleanup and stale response rejection. It does not exercise real dashboard authentication or replace a live Hermes compatibility check.

`tests/integration/remote-hermes.test.ts` and `tests/integration/remote-hermes-reservations.test.ts` check real database identity/receipt constraints, owned bindings, fixture cascade cleanup, queue reservation contention, revision reconciliation, unknown queue recovery and late acknowledgements. It runs only when `REMOTE_HERMES_INTEGRATION=1` and `DATABASE_URL` points to a disposable database named `hermes_fixture`; never set these to production. All migrations have been checked against a disposable pgvector/Postgres database. A real remote Hermes server has not yet been used for end-to-end verification.

## Remaining work

- Extend managed/local RPC and shared chat controls where the pinned runtime supports attachments, clarification, protected prompts, steering, queues and snapshots. Preserve process/filesystem isolation, approval semantics and profile identity checks.
- Add native profile settings and MCP administration with explicit secret handling and negotiated capabilities.
- Add authorized native workspace/files/projects and schedule/plugin/system panels. Profile names must not become tenant security boundaries.
- Integrate native remote connections into portal bot/chat navigation, history pagination and distributed hub ownership.

References reviewed: Vory `622c9b41d1fcb2cee3564a328c11cd72cff7ee18` and Hermes native contracts at `79af3f6cea8067284a7ea5725078578b3f790adb`. No real credentials or private deployment configuration are included.
