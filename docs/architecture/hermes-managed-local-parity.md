# Managed/local Hermes native chat controls

This delivery adds native attachments and active-turn controls to ordinary private bot conversations backed by the local controller or a user's managed Docker runtime. Personal remote dashboards retain their separate native workspace. Shared remote Runs API backends keep their existing behavior.

## Behavior

- The newest user message sends owned attachment bytes to native `image.attach_bytes`, `pdf.attach`, or `file.attach` before native prompt submission. Earlier attachments remain in Hermes's retained session. No browser URL, provider reference or local path is fetched by the adapter. Limits: eight files, 8 MiB each and 16 MiB total; the private controller accepts a bounded base64 envelope.
- A chat card shows the native model/provider context and numeric usage, single or batch clarification, and pending sudo/secret/vault prompts. Answers target a random portal request ID mapped to the exact pending native request. Protected values clear before acknowledgement and are neither transcript messages nor controller metadata. Existing allow-once/deny approval cards and chat Stop remain available.
- Steering and one queued message use native RPC. Write-ahead receipts contain content hashes and confirmed/uncertain/rejected outcomes; a repeated receipt never repeats dispatch. Explicit rejection stays rejected. Unconfirmed dispatch stops the exclusively owned engine. A queued user message belongs to native Hermes history rather than a separately persisted portal user message; its assistant output remains within the originating portal run.
- All native follow-up turns remain associated with that run until the owned gateway's worker scopes have drained. `message.complete`, idle snapshots and settled session-info alone are insufficient because Hermes emits them before steering follow-ups. A fixed controller bootstrap installs a narrow `collective.session.settled` observer that checks the pinned retirement fence, running/queue state and open requests. No arbitrary RPC is exposed to browsers and no pinned Hermes source files are modified. The local launcher and Docker bridge install the same extension. Turn-isolated compute-host execution is rejected at startup because this proof covers in-process workers only.
- Cancellation during attachment staging stops the owned engine to discard pending images before a retained native session is reused. Engine stop and restart preserve the native transcript and portal receipts; uncertain work is never automatically resubmitted.

## Authorization and storage

The authenticated chat API resolves the provider run from the conversation owner's recorded run, bot, app and target identity; clients cannot supply runtime IDs, provider run IDs, profile names or arbitrary methods. Group conversations and foreign bots are rejected. Mutations recheck the target before dispatch. Docker admission uses the existing locked access policy: disabling new work blocks steer/queue while allowing answers to admitted prompts, and transmits the corresponding creation lease. Revoked runtime enrollment remains enforced.

POST requires the portal Origin, JSON and a 32 KiB streaming body limit. Responses are private/no-store. Protected input and upstream errors are not logged; provider error details are replaced with a fixed message. Controller metadata stores identities and hashes only. Attachment bytes go to the user's native storage; bounded display replay, queued text and pending cards remain in controller memory.

Snapshots inspect only an already owned live native runtime with `omit_messages`; they never cold-resume unknown work. After a controller restart, native inspection becomes available when the next ordinary chat message resumes the retained session. Restart does not reconstruct expired prompt cards.

## Validation and limits

Controller fixtures exercise real Python stdio, Unix socket HTTP, the Hermes provider and the current AI SDK file transport. Tests cover attachment ordering/idempotency, cancellation during staging, single/batch/protected answers, rejected steering, write-ahead receipts, queued and steering follow-ups with protected prompts, and one terminal portal event after the final turn. Python probe tests model the pinned non-reentrant history lock and retirement reservations through post-complete cleanup and successor workers. API tests cover ownership, changed bindings, cancellation, admission disablement, Origin/body limits and protected error handling. Attachment resolver tests verify ownership filters and reject oversized batches before storage reads.

`node tests/browser/managed-hermes-controls.mjs` renders the real controls in Chromium with synthetic HTTP responses. It exercises clarification/skips, clearing protected values before acknowledgement, steering/queueing, rejection and unavailable inspection. No live Hermes server or production database is used by these checks.

This delivery does not add native command/settings/MCP/workspace administration to managed/local chat. Remote administration and navigation/history are separate stacked PRs; distributed remote hub ownership remains pending. Keep local deployment notes, credentials and Compose overrides out of the public repository.
