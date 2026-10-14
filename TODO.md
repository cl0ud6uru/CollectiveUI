# TODO, caveats & known limitations

This file lists what has been verified, what still needs your environment, known bugs, limitations, and the backlog.
Tick items off as they're done.

## 1. Status snapshot

- **Documentation reviewed against the checkout on 2026-10-12.** Historical test totals and build results are not current release certification. See [development and CI coverage](docs/development.md#running-the-tests) for the runnable suites and [review results](docs/reviews/documentation-audit.md) for this audit's checks.
- **Stack:** Next.js 16, AI SDK 7, Drizzle, pg-boss.
  - Auth.js v5 is still a **beta** release (`next-auth@5.0.0-beta.x`). Pin the version and review its changelog before upgrading.

## 2. Needs your environment (untested here)

- [ ] **Entra ID SSO**
  - Create the App Registration with the redirect URI `https://<portal>/api/auth/callback/microsoft-entra-id`.
  - Configure the groups claim as **"groups assigned to the application"**, and assign the relevant groups to the enterprise app.
  - The fallback for users in too many groups calls Microsoft Graph and needs `GroupMember.Read.All`.
- [ ] **Real Active Directory over LDAPS**
  - The nested-group lookup (`LDAP_GROUP_MODE=ad`, the `1.2.840.113556.1.4.1941` in-chain match) has only been tested against OpenLDAP (`member` mode), never real AD.
  - Check the default `sAMAccountName` / `userPrincipalName` user filter, `LDAP_CA_CERT` (internal root CA), and the service account's read permissions.
- [ ] **Real OpenAI-compatible endpoints**
  - Confirm tool calling works well enough for bots.
  - If the endpoint rejects `response_format: json_schema`, set `OPENAI_COMPAT_STRUCTURED_OUTPUTS=false`. Memory extraction, chat titles, "Create with chat" and "Save as skill" rely on structured output.
  - Check the embedding model used for memory and knowledge search (Admin → Bots & tools → Embeddings app).
- [ ] **Deployment-specific Docker validation:** CI definitions include the unit image and production worker smoke test. Verify the complete Compose stack, networking, mounts and directory fixture on your intended host; those checks do not certify your deployment.
- [ ] **Workspaces on the portal host:** install gVisor and register it with Docker, build the workspace image, and start `docker-compose.sandbox.yml` ([operator guide](docs/operations.md#workspaces-sandboxed-commands)). Here, sandboxd and the isolation suite ran against Docker 29.3 with gVisor, and the `sandboxd` image passed its start-up checks in a hardened container, but the whole compose stack (web + worker + sandboxd on the internal network) hasn't been started together.
- [ ] **Hermes Agent with a real model:** the integration was tested against a real Hermes gateway (v2026.9.24) running on the mock LLM. Try a profile on your real model (Claude through the Claude Subscription DirectSDK plugin, or an API key), with `approvals.mode: manual`, and check tool steps, an approval, a denial and Stop.
- [ ] **Microsoft 365 connector:** mail, calendar and file search, sending mail, and routine email notifications are untested. They need delegated Graph scopes (`ENTRA_GRAPH_SCOPES`) and admin consent.
- [ ] **Web search:** needs a SearXNG instance or a Brave API key.
  - Microsoft retired the Bing Search APIs in 2025, so the **Bing option is probably dead** (see backlog).
- [ ] **Network egress:** in the sandbox, `fetch_url` got HTTP 403 from the network proxy.
  - Confirm outbound access from the server.
  - Put intranet sites on the fetch allowlist (Admin → Bots & tools), because private IP ranges are blocked unless allowlisted.
- [ ] **Production hardening**
  - Put HTTPS / a reverse proxy in front, and set `AUTH_URL` to the public URL.
  - Generate strong `AUTH_SECRET`, `ENCRYPTION_KEY` and `TOOL_APPROVAL_SECRET` values, and keep them safe: losing `ENCRYPTION_KEY` makes stored API keys unreadable.
  - Back up Postgres and the uploads volume.

## 3. Known bugs / quick fixes

- [x] **Stop in direct chats only stopped the browser** (and closing the tab lost the rest of the reply while tools and billing carried on). Fixed by durable runs (P6): replies run in the worker, Stop cancels them on the server.
  - Cancellation is owned by the durable run and worker; disconnecting the browser must not cancel a direct reply.
- [ ] **E2E tests write to the dev database.** `tests/e2e/seed-e2e.ts` removes leftover bot copies and E2E routines, but chats and inbox items pile up. Use a separate test database.
- [ ] **Chat titles fall back to "New chat"** when the first message is only a scripted mock tool marker. This is cosmetic and only happens with the mock model.

## 4. Known limitations (by design for now)

**Group chats**
- [ ] Bots can't ask for approval in a group chat. Sensitive tools are declined, with a hint to use the bot's direct chat.
- [ ] Handoffs happen within the same turn. Grok Bot's bot-to-bot messages are asynchronous.
- [ ] A single message triggers at most 6 bot replies (`MAX_GROUP_REPLIES`).
- [ ] Members can't be changed after the group is created.
- [ ] Handoffs between bots are text only.

**Delegation:** native asynchronous delegates can relay workspace approvals to the originating chat or child task. Synchronous delegates and other delegated approval types remain unavailable. Delegation goes at most 2 levels deep. Native follow-ups use `continue_*` with the earlier task ID; Hermes continuation is unavailable. See [delegated tasks](docs/features/delegated-tasks.md).

**Routines**
- [ ] When a routine pauses for approval, you resolve it by opening the chat from the Inbox. There's no approve/deny button in the Inbox itself.
- [ ] Chat replies, routines and memory extraction only run while the **worker** (`npm run worker`) is running; without it a reply fails after a minute with "The background worker didn't pick up this reply".

**Knowledge files**
- [ ] Files are chunked and embedded during the upload request, so large files are slow. It should move to the worker.
- [ ] No OCR for scanned PDFs, and no image understanding for knowledge files.

**Attachments**
- [ ] Stored on local disk or a volume only; there's no Azure Blob or S3 adapter yet (`src/lib/files/storage.ts`).
- [ ] No virus/malware scanning.
- [ ] Unused uploads are never cleaned up.
- [ ] People viewing a shared chat link can't open its attachments (owner and admins only).

**Workspaces**
- [ ] No network access from workspaces (no package installs from the internet); egress with an allowlist comes with the gateway phase.
- [ ] No disk or inode quota per workspace; keep Docker's data root on its own filesystem.
- [x] The [workspace browser](docs/architecture/workspace-browser.md) supports files, previews, uploads, downloads and streamed commands. Rich image/PDF rendering and a persistent interactive terminal remain outside its scope.

**Hermes bots**
- [ ] Editing or regenerating a message does not rewind Hermes' native history. Original-file delivery is implemented for compatible Remote, managed and personal Docker Hermes contexts; unsupported gateways fail explicitly. See [attachment requirements](docs/architecture/hermes-remote-attachments.md).
- [ ] Approvals continue with Hermes' live stream when the continuation runs on the worker that holds it (always, with one worker). With several worker replicas it may land on another one, which re-attaches to the run (newer Hermes) or, on Hermes ≤ v2026.9.24, shows only the run's final result.
- [ ] A routine's Hermes approval waits in the Inbox, but Hermes denies it after its own `approvals.timeout` (5 min by default), and a waiting run takes one of Hermes' `max_concurrent_runs` slots.
- [ ] Manually connected Hermes profiles share native memory with their bot audience. Managed/personal profiles and Team Bot member contexts provide separate lifecycle paths; see [connections](docs/connections.md) and [Team Bots](docs/architecture/hermes-team-foundation.md).

**Search:** English full-text search only; there's no semantic search over past chats.

**Usage guardrails:** authentication throttles, run concurrency limits and native-search budgets exist. There are no general daily model-token quotas or cost caps. Provider spending and Codex allowance views report upstream/accounting data; they are not a universal enforcement layer.

**Durable runs (P6)**
- [ ] Group chats still run inside the request: they don't resume on reload, and closing the tab stops them.
- [ ] A reply interrupted by a worker restart isn't retried (its tools may have had side effects); it's saved as far as it got, with a note, and can be regenerated.
- [ ] Approvals that were pending when P6 was deployed still work, but a reload during their continuation doesn't resume the live stream (it shows once finished).
- [ ] Each worker runs at most `AGENT_RUN_CONCURRENCY` replies and `ROUTINE_RUN_CONCURRENCY` routines at once; beyond that, replies wait for a slot (add worker replicas for more).

**Model switching:** switching models in an existing chat starts a new chat, unlike ChatGPT, which switches mid-conversation.

**Dictation privacy:** dictation uses the browser's Web Speech API. **In Chrome, the audio is processed on Google's servers**, which may conflict with company policy. Firefox isn't supported. Consider disabling it, or swapping in a self-hosted speech-to-text service.

**Small screens:** bot details open as a dismissible sheet; workspace controls also have a mobile dialog. The native iOS app has its own supported subset; see [mobile](docs/mobile.md).

**Other gaps**
- [ ] The admin-defined HTTP tool templates from the original plan weren't built; MCP servers cover that use case.
- [ ] No SIEM export, data-retention policies or conversation export.
- [x] Encryption key rotation supports a keyring and worker rewrapping. Retain old keys until rewrapping and backup recovery have been verified; see [development](docs/development.md#architecture).
- [ ] No translations (i18n). Targeted keyboard, reduced-motion, mobile and native Dynamic Type checks exist; a comprehensive accessibility audit remains outstanding.
- [x] GitHub Actions covers type checking, lint, unit tests, selected browser/native fixtures, Docker and iOS checks. General database/LDAP E2E coverage still requires its stack.
- [ ] Security headers are minimal and there's no strict Content-Security-Policy.

## 5. Backlog

### P0: before a pilot
- [x] Fix Stop in direct chats (see section 3): durable runs, P6.
- [ ] Connect real Entra and/or LDAP and one real endpoint, then run the smoke checklist (section 6).
- [ ] Build and run the Docker images, and write down the deployment steps for your infrastructure.
- [x] GitHub Actions workflows are checked in under `.github/workflows/`. Expand general E2E automation with disposable Postgres, OpenLDAP and mock LLM services.
- [ ] Add general model-usage limits and per-user daily token caps beyond existing authentication throttles, concurrency and native-search budgets.

### P1
- [ ] Azure Blob / S3 storage adapter.
- [ ] Move knowledge-file processing into the worker.
- [x] Resumable streams (P6: `GET /api/chat/[id]/stream` replays and tails the run's event log).
- [ ] Edit group members; approvals inside group chats.
- [ ] Approve and deny from the Inbox.
- [ ] Teams notifications for routine results and approvals.
- [ ] Retention settings; conversation export.
- [ ] Strict CSP and security headers.
- [ ] Replace or remove the Bing web search option.

### P2: Grok Bot features not built yet
- [x] Fullscreen voice chat is implemented for Native and Hermes, including native iOS voice. Recorded voice memos remain separate future work; see [voice](docs/voice.md).
- [x] Message replies, reactions, bookmarks and per-user hiding are implemented. These are conversation interactions, not independently executing nested bot threads.
- [ ] Asynchronous bot-to-bot messages (the receiving bot wakes up later).
- [ ] Bots that live in Teams or Slack.
- [ ] Complete deployment-specific containment and egress verification before enabling the implemented private agent browser. General workspace network access and “teach a task” screen recording remain separate future work.
- [ ] More keyboard shortcuts (bot switching, find in chat).
- [ ] Review the Grok Bot docs sections not yet covered: *Skills and routines*, *Approvals, security and privacy*, *Files and results*.

## 6. Smoke checklist for the real environment

1. [ ] Sign in with Microsoft, sign out, then sign in with the company username (LDAP) as the same person. Both should land on **one** account (Admin → Users).
2. [ ] Map an AD group in Admin → Groups and restrict an app to it. Someone in the group sees the app; someone outside it doesn't.
3. [ ] Chat with a real endpoint, including a PDF attachment, and an image if the model supports vision.
4. [ ] Create a bot with a tool set to "Ask me first". Approve once and deny once, then check Admin → Activity.
5. [ ] Create a routine and press **Test run**. The result appears in the Inbox, and the run history shows ✓.
6. [ ] Start a group chat with two bots. Test an @mention and a handoff.
7. [ ] Share a template link, then open it as a second user and **Add to my bots**.
8. [ ] Check that Admin → Usage numbers and the CSV export look right.
9. [ ] Turn on Workspaces (Admin → Workspaces shows "gVisor isolation"), give a bot the Workspace tools with **Run commands → Ask me first**, approve a command, and check a second person on the same bot gets an empty workspace.
