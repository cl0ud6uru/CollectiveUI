# Workspace cleanup acceptance

The candidate starts from published main `c9583566` and keeps each repair in a
separate commit. It does not install images, change daemon/service configuration,
start Docker, use model providers or modify live workspaces.

- **325 — installed images:** `f5dd3d6` adds daemon-only validated image-ID
  configuration for fixed template profiles. Authenticated daemon health reports
  actual installed images; the portal retains its closed recipe/capability/seed
  policy and uses that report for availability. Missing/older reports fail closed.
  Fixtures configure daemon images or health instead of mutating portal globals.
- **326 — helper lifetime:** `88c4697` installs a 45-second wall alarm and a
  40-second CPU hard limit before helper input processing. Actual helper processes
  terminate pathological regex and open stdin without the test's kill watchdog;
  normal confined reads still pass. Rebuilding sandbox/starter images is required
  to distribute these helper bytes; no installed image was changed here.
- **327 — Stop:** `936320a` corrects the earlier `9939d55` scan. Actual commands
  allocate unique execution IDs and emit exact instance/execution metadata. The
  web action validates it and resolves only the authenticated owner's selected
  instance. Reused provider IDs and delayed old Stops cannot target a different
  execution. Independent review reproduced the old scan failure and approved
  the correction after combined production-tool/action probes. See
  [command Stop acceptance](workspace-command-stop-327.md) for native parity scope.
- **328 — retirement:** reservations carry durable configured retention before
  sandbox creation; binding success and old-unbound retirement commit together.
  Failed reservations retain deadlines; sweep backfills old crashes without
  extending existing dates. Re-enable clears only legacy/currently bound rows.
  A template still bound to another bot remains protected. The owner/account
  locking path caps retained template instances at 32 while permitting current
  version reuse. Configured retention may be zero. No schema migration is needed.
  Disabled-account reconciliation derives account deadlines only from legacy or
  currently bound instances; expired unbound retirement dates cannot shorten
  retention for active bindings. Separate cases cover both a missing account
  deadline and an already-existing future account deadline.

## Local checks

All 91 focused manager, recipe, tool, action, rendering and PGlite binding cases
pass together. They cover missing images before reservation/start, actual daemon
health from configured fixture images, profile/owner isolation, exact Stop
targeting, provisioning deadlines, failed starts, atomic replacement, shared
bindings, old-crash backfill, expiry/destruction, cap rejection and reuse at cap.
The actual-helper confinement/lifetime suite separately passes 3/3 in 45.17
seconds. Full TypeScript checking after Next route generation, targeted ESLint
and diff checks pass.

A final negative control restored only the earlier disabled-account lifecycle
source while keeping the new fixture: the expired-orphan cases deleted the bound
instance and failed their preservation assertions. The corrected reconciliation
keeps bound data through the account retention date and still deletes the
expired unbound instance.

The PGlite binding tests use a synthetic sandbox client and replace the owner
lock wrapper so they can interleave provisioning with a sweep. The production
owner/account locking path remains in place; these tests do not claim a live
Docker or PostgreSQL advisory-lock acceptance run. Existing workspace-lock
acceptance remains separate. Hosted required checks and final current-base
integration are reported by the parent task before publication/merge.
