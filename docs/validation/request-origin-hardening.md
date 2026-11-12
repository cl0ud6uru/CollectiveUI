# Request origin hardening

Validated against `origin/main` at `39cc403` using synthetic requests and data.

## Changes

- Cookie-authenticated voice mutations now require the exact configured public origin and JSON content type before reading the body or dispatching work. The former voice helper accepted a missing Origin and normalized malformed Origin URLs.
- Browser mutations for chat approvals/read state, native bot settings/Codex, personal ChatGPT/Codex accounts, administrator network changes, mobile consent, branding and pets share the configured-origin check. Missing, malformed, credential-bearing or non-HTTP(S) `AUTH_URL` values fail closed with HTTP 403; the incoming request URL and forwarded hosts cannot supply a fallback.
- Native settings, administrator network, MCP app and Team JSON readers reject prefix lookalikes such as `application/jsonp`. Valid JSON parameters and case-insensitive media types remain supported.
- Native bearer exceptions still require successful `requirePrincipal()` first. The existing session boundary checks a real token and proxy-owned mobile path, never a browser-cookie fallback. A regression exercises the real session module and mobile voice wrapper for verified, invalid, revoked and server-action transports.

## Verification

- 24 focused unit suites: **418 passed**. Includes the new origin and browser-mutation matrices, actual-session native voice tests, existing chat/voice/account routes, delegated approvals/read state, mobile/auth coverage, branding/pets, MCP apps, Team administrator networking and remote Hermes routes.
- `npm run typecheck`: passed.
- `npm run lint -- --quiet`: passed.
- `git diff --check`: passed.
- Actual PostgreSQL authentication and mobile integration: **2 suites, 28 passed, zero skipped**, with `AUTH_IDENTITY_POSTGRES_PROOF=1`, an explicitly allowlisted disposable loopback database and pool size 1. The local fixture used pgvector/PostgreSQL 16; hosted CI uses PostgreSQL 17. LDAP/authentication data was synthetic. Mobile consent also has route-level coverage for accepted forms and rejected configuration before code issuance.

## Platform behavior

Web callers already send the expected JSON content types and browser Origin. iOS and macOS share `CollectiveKit`: `APIClient` sets JSON content types, and `VoiceRequestPolicy` rewrites voice calls to `/api/mobile/v1/voice/*`. Native requests without Origin remain supported after token validation. Mobile sign-in consent remains a browser form with an exact-origin check. No UI, callback, webhook or native public-token protocol changed.

Deployments must configure `AUTH_URL` with their public HTTP(S) URL, as documented in the existing setup instructions. There is deliberately no request-host fallback.
