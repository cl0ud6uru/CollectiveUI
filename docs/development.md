# Developing CollectiveUI

[Back to the overview](../README.md) · [Local setup](getting-started.md)

## Architecture

```
Browser ──► Next.js 16 (App Router, React 19, Tailwind 4)
   ▲         ├─ Auth.js v5: local passwords (scrypt) + Microsoft Entra ID (OIDC) + LDAP (ldapts)
   │ SSE     ├─ /api/chat → saves the message, queues a run, streams it back from the run's event log
   │         ├─ server actions (conversations, bots, admin)
   │         └─ Postgres 16 + pgvector (Drizzle ORM) ◄── run events (LISTEN/NOTIFY)
   └──────────────────────────────────────────────────┐        ▲
Worker (pg-boss on the same Postgres) ── durable direct replies: Native / Hermes / Codex dispatch
                                     └── routines, memory extraction ──► model endpoints / MCP servers / Microsoft Graph / web
```

- `src/auth.ts`: sign-in providers. Directory users are keyed on their lower-cased **UPN**, so someone signing in through Entra or LDAP lands on the same directory account. Local users occupy a separate identity realm and are never linked by email or UPN. Directory groups are refreshed at every sign-in.
- `src/lib/authz.ts`: authorization helpers enforce connection, bot and MCP access using administrator, group and individual-user grants; conversations are checked by owner. Server entry points obtain their principal through `src/lib/session.ts`.
- `src/lib/agent/`: the agent runtime. `run.ts` handles native/Hermes direct and background runs; groups use `group.ts`, and the Codex pilot dispatches through `src/lib/codex/` from the durable executor. Native tools and approval policy live alongside `run.ts`.
- `src/lib/runs/`: durable runs. Every direct-chat reply and routine turn is a run the **worker** executes; its stream is written to Postgres (`run_events`), so it keeps going when the tab closes, a reload picks the live stream back up, Stop really stops the model and its tools, and approvals can be answered from any web instance. A reply cut short by a worker restart is marked interrupted with what it had written so far. Group chats still run inside the request.
- `src/worker/index.ts`: the background worker, safe to run as several replicas. Runs, cron routines and jobs are claimed atomically.
- API keys, MCP headers, Graph tokens and routine webhook secrets are stored with AES-256-GCM encryption, each bound to its column. Secret values are kept server-side; authorized configuration screens can display endpoint URLs and non-secret connection metadata.
- To rotate the encryption key, add the new key to `ENCRYPTION_KEYS` (`<kid>:<base64>`) and set `ENCRYPTION_PRIMARY_KID` to it. Keep the old key configured; the worker re-encrypts stored secrets under the new key when it starts.

## Running the tests

For a reproducible unit-test environment, use the dedicated Docker `test` target:

```bash
docker build --target test -t collectiveui-test .
docker run --rm --init --network none collectiveui-test
```

It runs `npm test -- --project unit` with `NODE_ENV=test` as the non-root `node` user, with a writable `/app`
and all locked development dependencies. The digest-pinned full Debian Node image includes `/usr/bin/python3`,
git and process tools for the checked-in synthetic native Hermes fixtures. No pip packages, live Hermes
installation, credentials, database or external runtime network are needed. `--init` reaps fixture descendants.
Run the complete current suite; historical test counts in older verification notes describe only those snapshots.
Do not bind-mount a checkout over `/app`, which would hide its installed dependencies and ownership.

Use this Linux target for the complete unit suite. Several Hermes custody, resource-helper and process-lifecycle fixtures intentionally exercise Linux-only production guards and `/proc` paths; running every unit suite directly on macOS can fail before the intended assertions. Those failures must not be reported as a passing suite. Cross-platform focused tests, type checking, lint and isolated browser fixtures can still run locally.

The production `worker` image is **not a test harness**: it runs with `NODE_ENV=production`, root-owned application
files and a non-root `app` user, and intentionally omits Vitest, Python fixtures and development tooling. Do not
switch it to root or change its permissions to run tests. See [worker image validation](testing/worker-image.md)
for the shipped dependency audit and a disposable migration/reply smoke test.

```bash
npm run typecheck && npm run lint
npm test                      # unit tests + integration tests (integration suites skip themselves without DATABASE_URL)
DATABASE_URL=postgres://… npm run test:integration   # DB-backed tests (e.g. secret re-encryption) against a migrated database
# E2E needs the dev stack + `npm run dev` + `npm run worker:dev` + mock-llm, then:
npm run test:e2e              # sign-in, chat, branching, search, access control, sharing, approvals, memory, routines, providers, ChatGPT sign-in, workspaces, durable runs (reload, closed tab, Stop)
SANDBOX_DOCKER=1 npm run test:sandbox   # sandboxd against a real Docker daemon: lifecycle, limits, and the isolation suite
node tests/browser/workspace-setup.mjs # isolated native Workspace setup UI; no app, DB, Docker or paid calls
HERMES_TEST_URL=http://127.0.0.1:8642 HERMES_TEST_PROFILE=coder HERMES_TEST_KEY=… npx vitest run --project integration hermes-live
```

CI (`.github/workflows/ci.yml`) runs `npm run typecheck`, `npm run lint` and `npm test` on every pull request and push to `main`. The checks job has no database or live Hermes, so opted-in integration/sandbox suites skip there. Separate CI jobs run synthetic browser fixtures, pinned native Hermes contracts and official-image Docker lifecycle tests. The general LDAP/database E2E suite still requires a separately running stack; run the suites your change touches. `.github/workflows/docker.yml` also checks the exact PR head using the Docker unit target and production worker audit/migration/reply smoke test. It uses only synthetic local fixtures and does not deploy anything.

`test:sandbox` needs Docker and the workspace image (`npm run sandbox:image`). It runs under gVisor when Docker has `runsc`, and `SANDBOX_TEST_RUNTIME=runc` runs it under standard isolation. The workspace e2e test runs only when `SANDBOXD_URL` is set (start `npm run sandboxd:dev` first). The Hermes tests (`hermes-live`, and `tests/e2e/hermes.spec.ts` with `HERMES_E2E_URL`/`HERMES_E2E_PROFILE`/`HERMES_E2E_KEY`) need a Hermes gateway whose profile runs on the mock LLM (`model.provider: custom`, `base_url: http://127.0.0.1:4010/v1`), so scripted tool calls work; offline, `tests/unit/hermes-provider.test.ts` replays events recorded from a real gateway.

The workspace setup fixture launches a new isolated Chromium and a loopback component server, blocking external browser requests. Set `CHROME_EXECUTABLE_PATH` to an installed Chromium and `WORKSPACE_SETUP_SCREENSHOT_DIR` to a private directory outside the repository for missing-prerequisite, authentication failure, pending/retry, readiness and confirmed-access screenshots. Its settings/health endpoints are synthetic. Unit tests separately exercise the real server actions and a signed loopback health client; no live installation or access grant is performed.

Hermes slash controls have separate isolated tests: `npx vitest run --project integration hermes-commands` (migrated disposable database) and `npx playwright test tests/e2e/hermes-commands.spec.ts` (normal dev stack and worker). The browser test starts its own fake Hermes HTTP service and performs no real tool or CLI execution.

Admin bot deletion has a dedicated browser suite: migrate a **new local database** named `collective_bot_delete_test` and run the app against it with `AUTH_LOCAL_ENABLED=true`, `AUTH_ENTRA_ENABLED=false`, `LDAP_ENABLED=false`, and synthetic auth/encryption secrets. Set `AUTH_URL` to that local app's origin; production builds require HTTPS (the dedicated test config accepts a local self-signed certificate). Export the same `DATABASE_URL` and set `BASE_URL` to that origin, then run `BOT_DELETE_BROWSER=1 npx playwright test -c playwright.admin-bots.config.ts`. This bypasses the broad E2E seed and creates/cleans only unique disposable fixtures. It covers keyboard/mobile cancel, pending and duplicate clicks, network failure and retry, actual deletion/cascades, protected Hermes refusal, revoked admin access, and the shared editor flow. Set `BOT_DELETE_SCREENSHOTS` to an output directory to capture the desktop, mobile, and error states; `PLAYWRIGHT_CHROMIUM_PATH` can select an installed Chromium.

Local authentication tests use **disposable databases only** (never an existing installation):

- `tests/integration/local-auth.test.ts`: set `DATABASE_URL` to a migrated database named `collective_local_auth_test`; run `npx vitest run --project integration local-auth.test`. This suite clears its local-account fixtures and bootstrap marker. Repeat with `DATABASE_POOL_MAX=1` to exercise transaction-only admin checks.
- `tests/integration/local-auth-upgrade.test.ts`: set `LOCAL_AUTH_UPGRADE_DATABASE_URL` to a **new, empty** `collective_local_upgrade_test` database. Run `npx vitest run --project integration local-auth-upgrade` to migrate through 0010, insert directory fixtures, apply 0011 twice, and check identity/data preservation.
- `tests/fixtures/local-auth/cli-smoke.py`: set `DATABASE_URL` to a **new, migrated** `collective_local_cli_test` and `AUTH_LOCAL_ENABLED=true`, then run it with Python 3. It exercises real hidden-TTY bootstrap/recovery prompts and verifies that passwords are not echoed. All passwords in this script are synthetic fixtures.
- `playwright.local-auth.config.ts`: run the development app on port 3100 with local-only auth, `AUTH_URL=http://localhost:3100`, synthetic secrets and the migrated `collective_local_browser_test` database. Export the same environment to Playwright and set `LOCAL_AUTH_BROWSER=1`, then `npx playwright test -c playwright.local-auth.config.ts local-auth.spec`. It creates/deletes only fixture accounts, checks login/admin/reset/revocation/CSRF, and saves screenshots under `/tmp/collective-local-screenshots`. A production-mode preview requires HTTPS; set both `AUTH_URL` and `BASE_URL` to that HTTPS origin and configure browser certificate trust.
- Combined-provider browser coverage uses a separate fixture server on port 3102 with all three providers enabled, synthetic Entra client ID `00000000-0000-0000-0000-000000000001`, a synthetic client secret and issuer `http://127.0.0.1:3110`. Start `node tests/fixtures/local-auth/oidc-discovery.mjs`, set `AUTH_PROVIDERS_BROWSER=1` and `BASE_URL=http://localhost:3102`, and run `npx playwright test -c playwright.local-auth.config.ts auth-providers`. The fixture never issues tokens; browser navigation is intercepted before reaching Microsoft. Callback unit tests cover Entra group/token synchronization separately. This does not replace a real Entra tenant test.
- With the seeded development LDAP directory and `collective_local_browser_test`, set `LOCAL_LDAP_TEST=1` and run `npx vitest run --project integration local-ldap-throttle`. It verifies that different username prefixes and email aliases share a canonical-DN throttle. General LDAP browser regression suites can opt into `E2E_RESET_AUTH_THROTTLE=1` to reset counters between synthetic logins; the helper refuses every database name except `collective_local_browser_test`. The production application has no test throttle/auth bypass.

Some unit tests are guard rails rather than behaviour tests. `authz-coverage` fails when a route handler or server action doesn't authorize through `src/lib/session.ts`. `policy-guards` fails if Claude subscription login or token-relay code creeps in (see `docs/architecture/backend-harness.md`).

The mock LLM also speaks the OpenAI Responses API (`/v1/responses`), Anthropic Messages (`/v1/messages`) and the ChatGPT Codex backend (`/backend-api/codex/responses`, which rejects requests that break that backend's rules), plus OpenAI's device-code sign-in for "Sign in with ChatGPT" (it approves every code on the second poll and signs people in on a Plus plan). Put `[slow]` in a message to stream it slowly, or `[limit]` to hit a ChatGPT plan limit. For the ChatGPT e2e test, start the app with `CHATGPT_AUTH_BASE_URL=http://localhost:4010` and `CHATGPT_BACKEND_URL=http://localhost:4010/backend-api` in `.env.local` (ignored in production).

## Project layout

```
src/
  auth.ts                 Auth.js (local + Entra + LDAP)          proxy.ts   route protection
  db/                     Drizzle schema, migrations, migrate script
  lib/auth/               ldap.ts, entra.ts (Graph), groups.ts (sync + permissions)
  lib/agent/              run.ts (agent loop), toolset.ts, tools/*, approvals.ts, memory.ts, routine-runner.ts
  lib/                    authz.ts, session.ts, llm.ts, crypto.ts, jobs.ts, settings.ts, files/*
  app/(chat)/             chat UI, bots, inbox, settings (+ server actions)
  app/admin/              admin panel (+ server actions)
  app/api/                chat (streaming), files, search, webhooks, health, auth
  components/             chat/, sidebar/, bots/, admin/, ui/
  lib/codex/              personal/legacy app-server dispatch, admission and recovery
  lib/delegation/         durable specialist tasks, follow-ups and workspace approvals
  lib/hermes-team/        Team Bot definitions, member contexts and native resources
  lib/voice/              voice sessions, reactions and diagnostics
  lib/sandbox/            sandboxd client, workspace session, policy, lifecycle
  sandboxd/               workspace daemon (plain Node, no npm deps; owns workspace Docker access)
  docker-hermes/          separate protected broker for personal/Team Hermes runtimes
  personal-codex/         protected per-owner Docker broker and native account flow
  agent-browserd/         isolated private browser runtime and transport
  lib/workspaces/         versioned catalog, caller/bot instances and lifecycle locks
  worker/                 background worker
docker/sandbox/           the workspace image and its helpers (run-agent, kill-run, fsops)
dev/                      mock-llm, mcp-echo, OpenLDAP seed, db seed
ios/                      SwiftUI app, CollectiveKit package and Live Activities extension
tests/                    unit/integration/sandbox (Vitest), E2E and isolated browser fixtures
```
