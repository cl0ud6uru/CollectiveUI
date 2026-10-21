# Native chat reply diagnostics

The Mac and iOS clients share `ChatModel.send()` and
`CollectiveKit.APIClient.streamChat()`. Both submit a bearer-authenticated
`POST /api/chat`; there is no separate Mac reply endpoint. Direct chats are
admitted by that route, executed by `src/lib/runs/execute.ts` in the worker, and
returned as SSE from the durable event log. Snapshots use `GET /api/chat/[id]`.

`[native] request failed` comes from `src/lib/llm/native-errors.ts`. Here
"native" describes the server runtime error boundary, not the Apple client.
Browser replies use it too. It can also describe a tool warning/error or a
persistence/hook failure, so the label alone does not establish that the main
model request failed.

## What has been reproduced

Against the main revision containing PR #294, a disposable PostgreSQL database
and the loopback mock model successfully exercised native bearer authentication,
first-message admission, durable execution, SSE framing, saved snapshots, and a
follow-up with the stored user/assistant history. Both new conversations and bot
home chats opened through the mobile API passed with the OpenAI Responses and
OpenAI-compatible transports. A controlled mock HTTP 400 produced one
correlated generic error, a failed run and the retained user message; the mock's
private provider detail reached neither the response nor the bounded diagnostic.

These fixtures do not reproduce or fix the reported live failure. They exercise
the server route and executor, not an actual Mac URLSession/browser/Keychain or
the installation's provider, bot configuration, tools, or existing history.
Do not infer a production root cause from the generic error text.

## Existing incident evidence needed

Use retained, read-only diagnostics for the original failure. No new live prompt
or tool action is needed for these lookups. Keep the resulting identifiers and
installation data in the owner's private diagnostic channel, outside a PR.

1. Retrieve the **complete structured log entry** matching the displayed reference,
   including its timestamp, `kind` (`provider` or `unexpected`), optional HTTP
   `status`, and whether the entry came from web or worker. Record the running
   application revision/image for both services; a merged client revision does
   not establish the deployed server revision.
2. Correlate that reference to the stored run/event envelope: run status, segment,
   execution mode, times, provider kind, whether text or tool chunks preceded the
   failure, and whether the reference was on an `error`, `tool-output-error`, or
   notice chunk. Do not export prompts, histories, raw chunks, tool arguments,
   outputs, bearer tokens, credentials, endpoints, or provider response bodies.
3. If `kind=provider`, the status is useful but does not identify the rejected
   request field or provider contract. If `kind=unexpected`, the existing log has
   no exception class, failing operation, stack, or cause. Obtain any **already
   retained** bounded failure category and failing operation from an authorized
   private diagnostic source. If these were not retained, the reference alone
   cannot recover them. Do not enable raw-error logging or guess a fix; construct
   a synthetic reproduction once the failing operation/contract is identified.

For an authorized operator with existing database access, this optional psql
query returns metadata only. Supply the displayed reference and a narrow UTC
time window from the log entry using psql variables `reply_reference`,
`window_start` and `window_end`. It does not select message or event contents.
The provider column is the current connection configuration, which may have
changed since the failure.

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
WITH matched AS (
  SELECT r.* FROM agent_runs r
  WHERE r.updated_at BETWEEN :'window_start'::timestamptz
                         AND :'window_end'::timestamptz
    AND (strpos(coalesce(r.error, ''), :'reply_reference') > 0
      OR EXISTS (
        SELECT 1 FROM run_events e
        WHERE e.run_id = r.id
          AND strpos(e.chunk::text, :'reply_reference') > 0
      ))
)
SELECT r.id AS run_id, r.status, r.segment, r.execution_mode,
       r.created_at, r.started_at, r.finished_at, r.billing_source,
       a.provider AS current_provider,
       count(e.seq) AS event_count,
       coalesce(bool_or(e.chunk->>'type' = 'text-delta'), false) AS had_text,
       coalesce(bool_or(e.chunk->>'type' LIKE 'tool-%'), false) AS had_tool_chunks,
       array_agg(DISTINCT e.chunk->>'type') FILTER (
         WHERE strpos(e.chunk::text, :'reply_reference') > 0
       ) AS reference_chunk_types
FROM matched r
LEFT JOIN ai_apps a ON a.id = r.app_id
LEFT JOIN run_events e ON e.run_id = r.id
GROUP BY r.id, r.status, r.segment, r.execution_mode, r.created_at,
         r.started_at, r.finished_at, r.billing_source, a.provider;
COMMIT;
```

No matching run can also mean expired/deleted evidence or a diagnostic emitted
outside the main reply stream. It is not proof of an authentication or Mac bug.

## Reproduce the fixture

Create a **new disposable** loopback PostgreSQL database named
`collective_native_reply_test`, apply the repository migrations, and run:

```sh
MOBILE_CHAT_REPLY_TEST_URL='postgres://postgres:synthetic-password@127.0.0.1:55439/collective_native_reply_test' \
  NODE_ENV=test npm test -- --project integration \
  tests/integration/mobile-chat-reply.test.ts --maxWorkers=1
```

The suite opts in only through `MOBILE_CHAT_REPLY_TEST_URL`; it does not use the
general `DATABASE_URL` as a fallback. It requires an explicit loopback port and
rejects URL/environment connection overrides before importing database modules.
Its fixtures have no configured tools, MCP servers, delegates, or live providers.
The job queue and memory-extraction scheduling are replaced with inert fixtures;
the real run executor is invoked directly. No live bot prompt, authentication
grant, merge, deployment, or native tool-output UI change is involved.
