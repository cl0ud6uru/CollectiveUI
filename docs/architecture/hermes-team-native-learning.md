# Native Team learning admission (disabled candidate)

The active worker entry is `startTeamCandidateRun` in `candidate-startup.ts`. It
checks the retained run's actor, conversation, bot, mode, profile, current worker
lease and exact verified model route before and after protected broker startup.
During streaming it refreshes the actor grant every 15 seconds without extending
the 120-second context expiry. Losing permission aborts delivery and retires the
exact context. Retirement closes provider tokens before asking the broker to
confirm native writers stopped. Cleanup retries cannot erase confirmed retirement.
The route inventory remains empty and the runtime flag remains off.

Native post-turn review uses a separate handoff token, not a reply or utility
token. The pinned `_spawn_background_review_now` hook supplies one final bounded
snapshot while the source worker remains open. `/api/hermes-team/native/:context/learning`
stores it encrypted with actor/source/receipt associated data. A changed review
UUID or snapshot cannot create another budget. The source must succeed and its
native writers must stop before a separately attributed background child can be
queued. Lost enqueue acknowledgments can be recovered before claim; a running
or uncertain child is never automatically repeated.

The background child gets a fresh context, worker lease and current session,
audience, maintainer, installed revision, binding and model checks. It can call
learning and utility models. It cannot reply, delegate, schedule another review
or access native company/member connectors. Its actual native review must use
Hermes's curator whitelist, skill read marks and memory manager; it is not an
ordinary chat prompted to extract memory. Private snapshot bytes are never
returned by member status, admin rollout or the handoff acknowledgment.

Migration 0043 adds the immutable learning receipt and retirement/worker metadata.
The actual database fixtures cover private encryption, one-source uniqueness,
terminal-token denial, separate child attribution, lost enqueue, ambiguous
execution, stale session/revision/binding/route/expiry, scoped revocation, lease
changes during startup, streaming renewal, and retained uncertain-dispatch
fences. Actual pinned full native learning scheduling and active Stop tests are
coordinated with the runtime increment; these database fixtures do not claim a
live model or OAuth verification. Normal personal Hermes startup is unaffected.
