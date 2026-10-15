# Actual pinned Remote Hermes dashboard conformance

The opt-in harness runs the complete upstream dashboard at Hermes source
`f97608f178d1ffeca59860195ab7da295f7c8e5f` (v0.21.5, desktop contract 8).
It verifies the production CollectiveUI dashboard client and WebSocket transport
against the native FastAPI application, password authentication and ticket routes,
RPC validation, attachment handlers, session registry, SQLite history, prompt
requests, queue and interrupt implementation. It also exercises the production
hub and durable reservation code with a disposable PostgreSQL database.

Only authentication-provider and agent construction are synthetic. The provider
rotates in-memory synthetic tokens; the agent produces deterministic replies and
native clarification, approval and protected-value requests without inference or
tools. A control shim can close connections or drop an admission acknowledgement
**after** the actual handler accepted it. It does not replace admission, resume,
interrupt, attachment, history or prompt-response handlers.

The fixture checks the exact source HEAD and rejects tracked or untracked source changes and a
source `.env`. Each child clears inherited environment variables, changes to a
fresh temporary home/profile, refuses external DNS/TCP/datagrams and allows only
local git inspection and PDF-rendering subprocesses through Python socket and
subprocess guards. These are fixture guards, not an OS sandbox or a universal
egress guarantee. No user profile, account,
grant, deployment or policy change is involved. Diagnostics are not saved as raw
artifacts. Tests assert zero external network attempts. Attachment assertions
compare original-byte digests read only inside the disposable home.

## Run locally

Use a clean checkout of the exact upstream revision and an isolated Python
virtual environment. Install `tests/fixtures/hermes-dashboard-requirements.txt`.
The source revision is also asserted by the Python fixture and TypeScript starter;
changing only the CI checkout cannot silently change the tested contract.

```sh
REMOTE_HERMES_DASHBOARD_CONFORMANCE=1 \
HERMES_SOURCE=/path/to/clean/pinned/hermes-agent \
HERMES_DASHBOARD_PYTHON=/path/to/isolated/venv/bin/python \
npx vitest run --project unit tests/unit/remote-hermes-dashboard-conformance.test.ts
```

Install Poppler and set `HERMES_REQUIRE_PDF=1` to require a rendered PDF page.
Without that flag the local test accepts only native error 5028 for unavailable
PDF capability, and still requires original image/file staging. CI installs
Poppler and requires PDF success.

For durable admission/reservation tests, migrate a **disposable** PostgreSQL
database named `hermes_fixture` on `127.0.0.1`/`localhost`. Set `DATABASE_URL` and a
synthetic `ENCRYPTION_KEY`; run `npm run db:migrate`, then:

```sh
REMOTE_HERMES_NATIVE_DATABASE_CONFORMANCE=1 \
REMOTE_HERMES_INTEGRATION=1 \
HERMES_SOURCE=/path/to/clean/pinned/hermes-agent \
HERMES_DASHBOARD_PYTHON=/path/to/isolated/venv/bin/python \
npx vitest run --project integration tests/integration/remote-hermes-dashboard-conformance.test.ts tests/integration/remote-hermes-reservations.test.ts --maxWorkers=1
```

Both integration suites reject another database name, a non-loopback host,
all URL query parameters and fragments before importing database-backed modules
or constructing their pool. PostgreSQL query overrides cannot change the effective
host/database after validation. CI checks out the pin and creates a disposable
`pgvector/pgvector:pg17` service, migrates it, and requires both suites.

## Evidence and limits

The native suite covers password login and refresh rotation, single-use WS tickets,
image/file/PDF delivery, persisted history, reconnect without resubmission,
protected/clarification/approval responses across reconnect, queue/stop, and native
acceptance followed by a lost acknowledgement. The PostgreSQL suite adds actual
transport contention, retained no-replay admission receipts and queue settlement.

This exposed an actual contract mismatch: `session.resume` rejects the REST-only
`inline_images` field. The hub now omits that RPC argument; the REST history path
retains its supported option.

Synthetic authentication and agent responses prove protocol integration; live
authentication and inference remain untested. They do not prove provider behavior,
live infrastructure, upstream credential revocation or deployed network security.
Native interrupt still does not provide an operation-correlated terminal receipt;
an idle snapshot cannot release an uncertain admission. The harness deliberately
does not add a timeout/idle force reset. See the recovery contract for that gap.

The subprocess guard remains a `Popen` subclass. Python 3.13 eagerly evaluates
native `Popen | None` annotations; replacing the class with a function breaks
the actual dashboard import even though Python 3.14 defers those annotations.
Both local 3.13 and 3.14 execute the same native fixture; CI requires 3.13.
