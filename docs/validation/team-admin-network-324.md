# Team admin runtime network authority

Reserved `team-admin:<botId>` owners now pass the protected broker network endpoint,
the audited Admin network API and the stopped-broker operator network commands.
The reserved owner syntax is accepted only for `/control/network` IPC. Personal
enable, lease, profile and Team actor endpoints still require a human owner ID.
The operator's network lease has no bot-creation permission or Team capability.

`POST /api/admin/hermes/network` keeps its origin, JSON-size, explicit restart
confirmation, request identity and expected revision checks. A reserved target
requires a fresh active administrator who is assigned to maintain the enabled
Team Bot. Bot and actor row locks preserve that authority through short dispatch,
and it is rechecked after the audit intent commits. The server issues an admin
Team grant for that bot-owned lease; it never looks up a personal enrollment for
the reserved owner. Personal targets retain the existing enrollment/cleanup checks.

The request body is the existing network request with `owner: "team-admin:<botId>"`.
The operator commands also accept that owner in `--network-plan`,
`--network-apply` and `--network-rollback`. Existing stopped-runtime, retained
profile identity, idle admission, journal replay and rollback behavior still apply.
This repair does not perform an actual network migration or enable a Team model route.

Three synthetic negative cases reproduce the original IPC/API rejection and missing
operator runtime lease on main `c9583566`. Positive tests exercise protected Unix
socket routing, a full synthetic runtime replacement with profile identities and a
separate personal owner retained, a stopped runtime remaining stopped, immutable
request replay, and the real PGlite schema for authorization and audit persistence.
They cover unassigned Admin/member/stale-session/disabled-Team denial, origin and
reserved-ID validation, uncertain dispatch retries, stale revisions and unchanged
personal enrollment requirements. No Docker daemon, provider, live account or
installed client is used.

No UI changes are included. The web Admin personal enrollment table retains its
existing personal controls; Team operators can use the protected Admin API or
reviewed CLI. iOS continues the Team web handoff and macOS continues to disable
unsupported native Team entry. Linux container acceptance and installed-client
acceptance remain separate from these synthetic checks.
