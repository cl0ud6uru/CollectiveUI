# Local-account authentication verification

Historical verification for the original password-only release. For the subsequent local passkey/TOTP implementation, see [local factor security and verification](local-mfa.md).

Verified 2026-10-01 in an isolated saved development environment. Base: current remote main `020552a0553d6eff4d9914f7ca0bc2aff4619463` (PR #8 was already merged remotely before this branch was created). No PR mutation, publication, deployment or real account creation was performed. All credentials/accounts used below are synthetic fixtures.

## Checks completed

| Check | Result |
| --- | --- |
| `npm run lint` | Passed, no warnings |
| `npm run typecheck` | Passed |
| `npm run build` | Production build passed |
| `npm test -- --reporter=default --reporter=json --outputFile=/tmp/local-full-tests.json`, with disposable migrated Postgres and synthetic encryption/session secrets | 633 passed, 33 skipped, zero failures |
| `npx vitest run --project integration local-auth.test` with `DATABASE_POOL_MAX=1` | 11 passed; directory admin mutation uses the transaction without requiring another connection |
| `npx vitest run --project integration local-auth-upgrade` with a new `LOCAL_AUTH_UPGRADE_DATABASE_URL` | 1 passed; seeded 0010 directory identities/roles/groups/chats survive 0011; migration repeated safely |
| `npx vitest run --project integration local-ldap-throttle` with `LOCAL_LDAP_TEST=1` and the isolated OpenLDAP fixture | 1 passed; username, email and arbitrary domain prefixes share the canonical directory DN counter |
| `python3 tests/fixtures/local-auth/cli-smoke.py` against new `collective_local_cli_test` | Passed real hidden-TTY bootstrap, duplicate bootstrap rejection, recovery, password-argument rejection and no password/hash echo |
| Playwright `local-auth.spec.ts` against the production build | 2 passed; desktop/mobile login, generic errors, Auth.js CSRF, admin action missing/foreign Origin rejection, HttpOnly/SameSite cookies, creation, mandatory change, role/private-chat isolation, reset, disable and session revocation |
| Playwright `auth-providers.spec.ts` against combined-provider build with loopback OIDC discovery | 1 passed; all enabled provider controls/API entries, Microsoft authorization redirect, callback URI and S256 PKCE |
| Existing Playwright `branding.spec.ts` | 1 passed; branding lifecycle, logo safety, login accessibility/responsiveness |
| Existing Playwright `bot-home.spec.ts` + `chat.spec.ts` | 12 passed; home/side/history/rollover/activity behavior and LDAP chat/access controls |
| Existing Playwright `bots.spec.ts`, `hermes-commands.spec.ts`, `providers.spec.ts` | 6 passed; approvals, memory, routines, duplication, Hermes commands, Claude mock provider |
| Existing Playwright `chatgpt.spec.ts`, `grok.spec.ts`, `mcp.spec.ts`, `runs.spec.ts`, `hermes.spec.ts`, `workspace.spec.ts` | 10 passed, 2 skipped; mock ChatGPT, group chats, bot preferences/templates, MCP, durable run reload/close/stop/approval behavior |
| `docker compose config` in a temporary fixture directory | Valid configuration with a synthetic password; correctly rejects an empty password |
| `git diff --check` | Passed |

Browser totals across the separate successful runs: **32 passed, 2 skipped**. Initial runs exposed a temporary-login redirect URL issue, fixed before the final local browser run. One home-chat timing assertion passed on a warmed rerun; simultaneous Playwright suites initially collided in their default artifact directory, fixed by using separate output directories. A CLI harness attempt timed out; the subsequent complete hidden-TTY smoke run passed. No final failing test remains.

The 33 skips in the full Vitest run are 24 Docker sandbox tests, 7 live Hermes tests, and the separately executed upgrade and LDAP fixture tests. The two browser skips are the live Hermes gateway and Docker workspace flows. A real Entra tenant round trip, production LDAP/AD TLS and live model credentials were not available. Docker sandbox/workspace fixtures were not configured. The full production Compose stack was not started; its configuration was validated. Microsoft's discovery DNS lookup returned `EAI_AGAIN`; Entra browser initiation therefore used the committed loopback discovery fixture and intercepted external navigation. Auth.js callback unit tests independently verify Entra group-overage resolution, token persistence, identity/version binding and session expiry. No production authentication bypass was added.

## Security review

An independent Astra reviewer inspected the security-critical implementation twice. The first review identified three medium issues: indefinite renewal of legacy JWTs, LDAP alias throttle splitting, and a transaction holding one database connection while requesting another. All were fixed and covered by targeted tests. The second review found no remaining critical, high or medium blocker. The reviewer inspected tests but did not independently rerun the fixture suites.

## Deployment requirements

Apply `0011_local_accounts` before the new application code; existing directory data stays in its own realm. Set `AUTH_LOCAL_ENABLED=true` to opt in; use `AUTH_ENTRA_ENABLED=false` and `LDAP_ENABLED=false` for local-only mode. Configure HTTPS `AUTH_URL`, persistent Postgres/uploads, independent strong application secrets and a unique `POSTGRES_PASSWORD` (production Compose now fails instead of using a default). Bootstrap only through the documented interactive operator command. Keep its acknowledgement flag out of persistent environment files. See README for trusted-proxy throttling, temporary-password delivery, recovery, revocation and upgrade compatibility.

Local auth has no MFA and this remains a single-organization installation, not a multi-tenant SaaS boundary. Already authorized in-flight responses cannot be recalled by revocation. Live-provider/deployment validation is still required before a production rollout.
