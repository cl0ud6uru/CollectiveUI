# Protected native Team runtime

Active candidate startup is a separate broker capability, disabled by default through
`teamCandidateRuntimeEnabled`. The application must verify a current worker run and an
issued model context before using protected Unix-socket IPC. The verified model and
tool inventories remain empty; this increment does not enable a model route or pilot.

`prepare-candidate` retains opaque grants only in memory. `start-candidate` binds its
actor, Team Bot, mode, retained binding, context, run and conversation. It reserves a
durable start receipt before launching, refuses uncertain replay, and holds all known
sibling controllers idle before restarting the retained owner container. Native
gateway processes also hold a runtime lock. Private session identity and the admission
receipt are derived on the server; requests cannot choose another profile or history.

Every native dispatch and approval continuation checks the active actor grant and
runtime generation. `renew-candidate` accepts a freshly authorized exact context but
does not extend its original 120-second lifetime. Application streams must renew
authority while open and retire promptly if authority changes. Shared admin profiles
retain separate private conversation contexts; another maintainer's grant cannot
keep a revoked actor's native work alive.

`retire-candidate` accepts only an exact retained receipt, including after the run or
audience access ends. Confirmed duplicate retirement cannot stop a newer context.
Cancellation is currently runtime-wide. Startup refuses active siblings; unconfirmed
cleanup fences further work and requires reconciliation rather than replay.

The synthetic broker regression suite exercises startup, stream admission, history
scope, expiry, shared-admin revocation, sibling refusal, delayed startup and retirement
replay. Actual pinned-source lifecycle fixtures provide distinct native source
evidence. Original-image execution, a complete active background-learning handoff,
and live model/auth/pilot verification are separate checks; none are claimed here.
