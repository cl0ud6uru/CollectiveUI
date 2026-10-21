# Plan: Generalized event-trigger framework for routines

Status: types/schema checkpoint for review. The additive schema and shared types are implemented; ingestion, dispatch, connections, providers, event editing, rate limits, and retention remain follow-up work. This checkpoint does not activate event routines.

## 1. Current state

Routines support exactly two triggers, hard-coded as a string union in several places.

**Schema** (`src/db/schema.ts`)
- `routines` table, `:910-929`. `triggerType: text("trigger_type").$type<"cron" | "webhook">()` at `:920`. Trigger-specific config lives in flat columns: `cron`, `timezone` (`:921-922`), `webhookSecret` (`:923`), `nextRunAt` (`:926`, cron only).
- `routineRuns`, `:938-964`. `trigger: "schedule" | "webhook" | "manual"` at `:949-951`. `payload jsonb` at `:952` already takes arbitrary event data. `lastEnqueueAt` (`:957`) makes queued rows a durable outbox (migration `0014_routine_admission_outbox.sql`).
- Template snapshot type repeats `triggerType: "cron" | "webhook"` at `:768-774`.
- `inboxItems.routineRunId` (`:1260`) and `agentRuns.routineRunId` (`:1302`) link results back.

**Trigger ingestion**
- Cron: `scheduleDueRoutines` in `src/lib/agent/routine-runner.ts:158-185` selects `triggerType = 'cron' AND nextRunAt <= now` and does a CAS claim on `nextRunAt` (`:174-177`). It then inserts a `routineRuns` row with `trigger:"schedule"` and enqueues `QUEUES.routineRun` (`:179-182`). Ticked from `src/worker/index.ts:120-129` every `SCHEDULER_INTERVAL_MS` (20 s).
- Webhook: `src/app/api/routines/webhook/[id]/route.ts:13-42`. It is one URL per routine. Auth is HMAC `X-Portal-Signature` or a Bearer secret (`:22-26`), the body is capped at 100 KB (`:16`), and JSON falls back to `{text}` (`:29-36`). It inserts a run and enqueues it (`:37-40`), returning 202. The route is public via `src/lib/public-routes.ts:6`.
- Manual: `runRoutineNow`, `src/app/(chat)/bots/actions.ts:627-629`.
- Secrets: `src/lib/routines.ts:18-25` (encrypted with `AAD.routineWebhookSecret`, legacy plaintext tolerated).

**Execution** (shared by every trigger already, which is the good news)
- Worker `src/worker/index.ts:82-85` consumes `QUEUES.routineRun` → `executeRoutineRun` (`routine-runner.ts:27-90`). This step claims queued→running, checks the owner, bot, and app, and creates the conversation. It appends `run.payload` as a fenced JSON block to the prompt (`:69-70`, truncated to 20 k chars), then hands off to the durable agent run.
- Results: `afterRoutineTurn` (`:96-155`) writes the inbox item and optional email.
- Recovery: `sweepRuns` re-enqueues stale queued routine runs (`src/worker/index.ts:49-66`).

**Create/edit**
- Server action `saveRoutine`, `src/app/(chat)/bots/actions.ts:557-611`. Zod `triggerType: z.enum(["cron","webhook"])` at `:562`. It computes cron `nextRunAt` (`:575-582`) and mints the webhook secret (`:602-608`). Template export and import live at `:661` and `:708-712`.
- UI `src/components/bots/routine-editor.tsx`: the type is at `:18`, `scheduleText` at `:46-47`, the trigger `<Select>` at `:185-188`, the cron builder at `:189-240`, and the webhook URL/secret display at `:241-248`.
- Display branches on `cron` vs everything else: `bot-panels.tsx:216-223`, `bot-side-panel.tsx:124`, `templates/[token]/page.tsx:88-91`, `bots/[id]/page.tsx:129-135`.
- There is no Slack code in `src/` today.

**Takeaway:** the run pipeline (`routineRuns` outbox → queue → `executeRoutineRun`) is already trigger-agnostic. What doesn't generalize is (a) the closed unions, (b) trigger config spread across flat columns, and (c) no fan-out step: a webhook is 1 URL → 1 routine, with no "event → many routines" matching.

## 2. Proposed schema changes

### 2.1 `routines`
- Widen `triggerType` to `TriggerType = "cron" | "webhook" | "event"`. Here `event` means an integration-provided event, and which provider is given by `triggerConfig.provider`. **Alternative**: use provider names directly (`"slack"`, `"github"`). Recommendation: `"event"` keeps cron/webhook special-cased while every integration shares one code path. See open question Q1.
- Add `trigger_config jsonb` (nullable), validated per provider by zod:
  ```ts
  type TriggerConfig =
    | { kind: "cron"; cron: string; timezone: string }            // mirror only; columns stay source of truth in phase 1
    | { kind: "webhook" }
    | { kind: "event"; provider: "slack"; connectionId: string; version: 1; match: SlackMatch }
    | { kind: "event"; provider: string; connectionId: string; version: number; match: unknown };

  type SlackMatch = {
    kinds: ("message" | "mention" | "keyword" | "reaction")[];
    channelIds?: string[];          // empty/absent = all channels the app is in (owner must opt in)
    keywords?: string[];            // for "keyword"; case-insensitive, word-boundary
    reactions?: string[];           // emoji names for "reaction", e.g. ["eyes","ticket"]
    includeBots?: boolean;          // default false (loop protection)
    threadReplies?: boolean;        // default false
    userIds?: string[];             // optional author filter
  };
  ```
- Add `trigger_provider text` (denormalized from config, nullable) and `trigger_connection_id text`. Then add the index `routines_event_idx (trigger_provider, trigger_connection_id) WHERE enabled AND trigger_type='event'`, so matching never scans all routines.
- Keep the `cron`, `timezone`, `webhookSecret`, and `nextRunAt` columns. The scheduler's CAS on `nextRunAt` is correct, so it shouldn't be rewritten.

### 2.2 `routineRuns`
- Widen `trigger` to `"schedule" | "webhook" | "manual" | "event"`.
- Add `trigger_event_id text` plus a **unique (routine_id, trigger_event_id)** index for idempotency, because Slack retries deliveries.
- `payload` stays, but for events it holds the provider's *normalized* event (see §3), not the raw body.

### 2.3 New tables
- `trigger_connections`: `id, provider, owner_id (or org scope), external_id (e.g. Slack team_id), display_name, credentials (encrypted, new AAD.triggerConnection), scopes, status, created_at`. Unique `(provider, external_id)`.
- `trigger_events` (inbound log / dedupe / audit): `id, provider, connection_id, external_event_id, received_at, event_type, matched_count, status ("matched"|"no_match"|"rejected"), payload jsonb (trimmed)`. Unique `(provider, external_event_id)`. Rows are purged after N days.

## 3. `TriggerProvider` interface

Location: `src/lib/triggers/` with `types.ts`, `registry.ts`, `dispatch.ts`, and `providers/slack/*`.

```ts
export interface NormalizedEvent {
  provider: string;
  connectionExternalId: string;   // Slack team_id, GitHub installation id, ...
  eventId: string;                // stable dedupe key
  type: string;                   // provider-specific, e.g. "message", "reaction_added"
  occurredAt: Date;
  actor?: { id: string; name?: string; isBot?: boolean };
  context?: Record<string, string>;   // channelId, threadTs, repo, ...
  text?: string;
  raw?: unknown;                  // trimmed, never contains secrets
}

export interface TriggerProvider<Match = unknown> {
  id: string;                                  // "slack"
  displayName: string;
  matchSchema: z.ZodType<Match>;               // validates routines.trigger_config.match
  /** Authenticate the raw request (signature, timestamp skew). Must use the raw body. */
  verify(req: Request, rawBody: string): Promise<{ ok: true } | { ok: false; status: number }>;
  /** Protocol handshakes (Slack url_verification) answered synchronously. */
  handshake?(rawBody: string): Response | null;
  /** Raw → zero or more normalized events. */
  parse(rawBody: string, headers: Headers): NormalizedEvent[];
  /** Pure: does this event fire this routine? No I/O. */
  matches(event: NormalizedEvent, match: Match): boolean;
  /** Shapes routineRuns.payload / prompt context. */
  toPayload(event: NormalizedEvent): unknown;
  /** Optional: UI metadata (list channels, etc.). */
  describeMatch?(match: Match): string;        // for scheduleText()/panels
  oauth?: { authorizeUrl(state: string): string; exchange(code: string): Promise<ConnectionCredentials> };
}
```

The registry is a static map (`registry.ts`), so there is no dynamic plugin loading. Cron and webhook stay outside the registry in phase 1. They could later be wrapped as "built-in providers" behind the same `describe/validate` surface for UI uniformity only.

## 4. Delivery path

```
POST /api/triggers/[provider]           (public, added to PUBLIC_PREFIXES)
  1. provider = registry[provider] ?? 404
  2. raw = await req.text(); size cap (reuse 100 KB rule)
  3. handshake? → return immediately
  4. verify(req, raw) → 401 on failure
  5. events = parse(raw)
  6. INSERT trigger_events ... ON CONFLICT (provider, external_event_id) DO NOTHING
     → duplicate? return 200 (ack) and stop
  7. return 200 fast (Slack requires <3 s) — fan-out happens in the worker:
     enqueue QUEUES.triggerDispatch { triggerEventId }
worker: dispatchTriggerEvent(triggerEventId)
  8. load event + connection; candidates = routines WHERE enabled AND trigger_type='event'
       AND trigger_provider=$p AND trigger_connection_id=$c          (indexed)
  9. for each candidate: provider.matches(event, config.match)
 10. one tx: INSERT routineRuns (trigger:"event", trigger_event_id, payload=toPayload(e), lastEnqueueAt)
       ON CONFLICT (routine_id, trigger_event_id) DO NOTHING; update trigger_events.matched_count
 11. enqueue QUEUES.routineRun per new run   (identical to webhook route.ts:37-40)
 12. existing executeRoutineRun / sweeper / afterRoutineTurn unchanged
```

Notes:
- The `trigger_events` row is the outbox for step 7. The sweeper gets one more clause, "received but not dispatched after N s → re-enqueue", following the `lastEnqueueAt` pattern.
- Per-routine rate limit and debounce (`maxRunsPerHour`, default for example 30), so a chatty channel can't spend the model budget. Excess events are recorded as `skipped`.
- Authorization is unchanged. `executeRoutineRun` already re-checks the owner, the bot, and the app (`routine-runner.ts:44-49`).
- Prompt injection: event text is untrusted. Keep it inside the fenced payload block (`:70`) and add a short preamble saying the payload is external data.

## 5. Slack provider (outline)

- **Transport**: Events API over HTTP (`/api/triggers/slack`), not Socket Mode (Socket Mode needs a long-lived connection; it could be an option for air-gapped deployments later). Handle `url_verification` in `handshake`. Ack fast; Slack retries carry `X-Slack-Retry-Num`, deduped through `event_id`.
- **Verify**: `X-Slack-Signature` = `v0=` HMAC-SHA256(signing secret, `v0:{ts}:{raw}`), with a 5-minute skew check on `X-Slack-Request-Timestamp`. Reuse `hmacSha256Hex`/`safeEqual` from `src/lib/crypto`.
- **OAuth**: OAuth v2 install (`/api/triggers/slack/oauth/start` → `.../callback`), with signed `state` tied to the user session. The bot token (`xoxb`) is stored encrypted in `trigger_connections.credentials` with `external_id = team_id`. Bot scopes: `channels:history`, `groups:history` (private channels, optional), `app_mentions:read`, `reactions:read`, `channels:read` (channel picker), `users:read` (names). Event subscriptions: `message.channels`, `message.groups`, `app_mention`, `reaction_added`. The signing secret and client id/secret are env or admin settings (see Q3).
- **Channel filters**: the editor lists channels via `conversations.list` using the connection token. The routine stores `channelIds`. The bot must be a member of each channel; the UI warns when it isn't.
- **Match kinds**:
  - `message`: any new top-level message in the selected channels (thread replies only if `threadReplies`).
  - `mention`: an `app_mention` event, or a message containing `<@BOT_USER_ID>`. A message event and an app_mention event for the same message are deduped by `channel+ts` to avoid a double fire.
  - `keyword`: a `message` whose text matches any keyword (case-insensitive, word-boundary, ≤ 20 keywords).
  - `reaction`: `reaction_added` with `reaction ∈ reactions`. The payload includes the reacted message (fetched in the worker via `conversations.history`, not in the ack path).
- **Loop protection**: drop events whose `bot_id` or `subtype` is `bot_message`, or whose user is our bot user, unless `includeBots` is set.
- **Payload** for the prompt: `{ team, channel:{id,name}, user:{id,name}, text, ts, threadTs, permalink, kind, reaction? }`.
- **Replying to Slack** (posting results back to the thread) is out of scope for this framework. It is an output or tool concern and should be a follow-up (Q5).

## 6. Migration and backwards compatibility

- Migration `0067_event_triggers.sql` is additive only. It adds the `trigger_config`, `trigger_provider`, and `trigger_connection_id` columns and the partial index; adds `routine_runs.trigger_event_id` with the unique index; and creates the `trigger_connections` and `trigger_events` tables. `trigger_type` is plain `text`, so widening the union is a TS-only change with no enum ALTER. Optionally add a CHECK constraint `trigger_type in ('cron','webhook','event')`.
- Existing cron and webhook rows are left as-is: `trigger_config` stays NULL. Cron keeps the `cron`/`timezone`/`nextRunAt` columns and `scheduleDueRoutines` is unchanged. The webhook keeps `/api/routines/webhook/[id]` and its secret, so external callers see no URL or secret change.
- An optional later backfill writes `{kind:"cron",...}` / `{kind:"webhook"}` into `trigger_config` for uniform reads. The columns stay authoritative until a deliberate cleanup PR.
- Templates (`schema.ts:768-774`, `actions.ts:661,708-712`): event routines are exported **without** `connectionId`/`channelIds`, and on import they become `enabled:false` with "connect Slack to activate". Unknown `triggerType` values in old template snapshots don't arise, since old snapshots are only cron/webhook.
- UI fallbacks: every `triggerType === "cron" ? … : Webhook` ternary (bot-panels, bot-side-panel, templates page, `scheduleText`) becomes a `switch` with an `event` branch, so an event routine isn't mislabeled "Webhook".
- Rollback: the new columns and tables are ignored by old code. Old code would treat `event` routines as webhooks for display only, and the webhook route already 404s them because there is no secret.

## 7. PR breakdown

1. **Types and schema (no behavior change):** `TriggerType` and `RoutineRunTrigger` shared types replace the scattered unions, plus migration 0067, drizzle schema, and zod `TriggerConfig`. The UI `switch` refactor of the ternaries is included.
2. **Framework core:** `src/lib/triggers/{types,registry,dispatch}.ts`, `QUEUES.triggerDispatch`, the worker handler, the sweeper clause, idempotent run insert, and rate limit. Unit tests use a fake provider (matches, dedupe, fan-out, and a lost-enqueue recovery test).
3. **Public ingress route:** `/api/triggers/[provider]` + `PUBLIC_PREFIXES`, body cap, handshake/verify/parse, and `trigger_events` insert. Tested with the fake provider.
4. **Connections:** the `trigger_connections` CRUD server actions, the encryption AAD, and a minimal "Integrations" settings list (connect and disconnect).
5. **Slack provider, ingest:** verify, url_verification, parse, matches for all four kinds, loop protection, and tests with recorded Slack fixtures.
6. **Slack OAuth install and channel listing:** start and callback routes, the `channels` list API for the editor.
7. **Editor UI:** a third trigger option "When something happens in Slack", with a connection picker, channel multi-select, kinds, keywords, reactions, and `describeMatch` in panels. `saveRoutine` zod and validation go through `provider.matchSchema`.
8. **Template export and import** handling for event routines, plus a prompt-injection preamble for event payloads.
9. *(follow-up)* Admin activity view of `trigger_events`, retention purge job, and the GitHub provider as the second consumer to validate the interface.

## 8. Decisions (Jason, 2026-10-13)

1. **Trigger type:** generic `triggerType: "event"`; the provider lives in `trigger_config.provider` (and the denormalized `trigger_provider` column).
2. **Connection ownership:** an admin installs **one** Slack workspace, shared by the whole org. `trigger_connections` is org-scoped (`installed_by` instead of `owner_id`); routines reference it by `connectionId`.
3. **Slack app model:** each deployment creates its own Slack app. Client id/secret and signing secret come from env or admin settings. We ship a Slack app manifest (`docs/slack-app-manifest.yaml`) with the scopes and event subscriptions from §5.
4. **v1 scope:** public channels only (`channels:history`, `channels:read`, `app_mentions:read`, `reactions:read`, `users:read`; events `message.channels`, `app_mention`, `reaction_added`). No `groups:*`/`im:*`. Results go to inbox/email only; there are no Slack replies.
5. **Limits and retention:** default 30 runs/routine/hour (excess events logged as skipped). `trigger_events` are purged after 30 days. Any user can create Slack routines against the admin-installed workspace; no extra permission gate.

## 9. Remaining open questions

- Is a global per-org cap needed on top of the per-routine limit? Default: no for v1.
