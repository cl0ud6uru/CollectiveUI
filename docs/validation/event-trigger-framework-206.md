# Event-trigger schema checkpoint integration

Source PR: #206, `0e7e2e5b061c5a2bc64de87adfdc3372142d07db`.
Integrated main: `76b1cb4e254ac643776f001a3342f33235a64397`.

The local integration preserves the source branch's three unique commits and merges main normally. The source PR changes no workflows, dependencies, package manifests, or executable scripts relative to its merge base. No fork workflow run was approved.

## Migration resolution

Main already owns `0058_openrouter_models` and migrations through `0066_mcp_apps`. Its existing migration SQL, journal timestamps, and snapshots through 0065 are retained. The event migration moves to `0067_event_triggers` with a timestamp after all prior entries.

Main's handwritten 0066 migration had no snapshot. A 0066 snapshot was generated from main's exact schema; Drizzle's diff against 0065 contains only the already-migrated MCP App tables, constraints, foreign keys, and indexes. The 0067 snapshot is generated from the integrated schema with 0066 as its predecessor. Its diff contains only the event storage additions. A final snapshot-to-schema diff has no pending SQL.

## Offline verification

- `npm run typecheck` passed.
- Changed-file ESLint and `git diff --check` passed.
- Six focused files covering trigger types, event migration, remote Hermes migration ordering, web sessions, ChatGPT companion storage, and OpenRouter upgrade passed 10 tests.
- Routine hook regressions passed 15 tests.
- The new PGlite migration proof applies all existing migrations through 0066, inserts cron/webhook routines and a historical run, applies 0067, and verifies unchanged existing values, nullable new fields, event/run deduplication, multiple legacy runs with null event IDs, supported trigger constraints, connection deletion behavior, and retained run attribution.
- Snapshot tests verify that 0066 adds only the two existing MCP App tables and 0067 adds only event tables plus changes to routines/routine runs.

These are synthetic local checks. No external provider, production database, GUI, deployment, account configuration, or Slack workspace was used.

## Remaining implementation boundaries

This is dormant schema/type groundwork. Event creation remains absent from the editor and server input enum. Provider ingress, signature verification, OAuth/credential encryption, authorization and channel access, event dispatch/outbox recovery, rate limits, retention, template connection rebinding, and complete event editing remain follow-up work.

Before activating event routines, editing must preserve their provider binding instead of defaulting to cron, and template/copy flows must explicitly rebind or refuse unsupported event routines. The current fallback display is not complete provider UX. This checkpoint does not establish any live integration acceptance.

Parity: web keeps existing cron/webhook controls. iOS and macOS currently expose routine results through Inbox and routine conversations; neither has the web routine editor. No native data contract or UI changes are required for these dormant additions. Native runtime behavior was not exercised.

The external fork and PR have not been mutated, and this integration has not been published. Parent review and fresh protected-branch CI are required before any merge.
