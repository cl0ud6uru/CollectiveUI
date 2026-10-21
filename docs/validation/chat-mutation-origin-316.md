# Chat mutation request boundary (#316)

The five routes named in #316 authenticated the caller but did not bind browser
mutations to the configured public origin. JSON parsing also accepted a
`text/plain` body. A cookie-bearing request from a sibling subdomain could
therefore change `/yolo` controls and admit a durable reply.

After authenticating with `requirePrincipal`, the chat, command, stop,
native-search and file-upload mutations now use the shared
`assertMutationRequest` guard. Cookie requests require the exact origin derived
from `AUTH_URL`; missing, opaque or different origins fail before reading the
body or touching storage. The four JSON routes require `application/json`
(parameters are accepted). File uploads retain `multipart/form-data`.

Native parity: iOS and macOS share CollectiveKit's API client, which supplies a
bearer token and JSON content type, or multipart content type for attachments.
Verified bearer requests may omit Origin. Existing session authentication still
judges bearer requests by their token alone; malformed or revoked tokens cannot
fall back to browser cookies. Web fetches already supply the expected JSON or
multipart formats. No client UI or installation configuration changes are needed.

## Verification

- Baseline `2de678b5346e1babe06c3dcf60e9b6df4bdec0ed`: the current route-boundary
  suite has **43 failing / 19 passing cases** against the original route files.
  The two-step synthetic sibling-origin `/yolo on` and prompt sequence returns
  **200 / 200** before the guard, and **403 / 403** after it. All execution,
  queue, database and file-storage boundaries in that suite are synthetic.
- The repaired route suite passes **62/62** cases, including each endpoint's
  browser and bearer requests, missing/foreign/opaque origins, missing public
  origin configuration, rejected content types and multipart compatibility.
- Four tests execute the real `requirePrincipal` selection logic with synthetic
  cookie/mobile lookup boundaries. Malformed/revoked bearer requests never
  consult browser cookies; a verified token remains accepted.
- The focused suite passes **125/125** tests across request-boundary, bearer-auth,
  command-route, Team admission, recent-send, mobile-auth, authorization-coverage
  and policy-guard tests. Existing Team/recent-send tests use embedded PostgreSQL
  and production admission code with synthetic queues.
- Typecheck, targeted ESLint and diff checks pass.

The disposable PostgreSQL model-routing, native-search and Hermes-provisioning
fixtures were updated to include real browser request headers; their separate
opt-in database suites were not executed locally. Required hosted checks remain
a publication/merge gate. This change is limited to #316; it does not claim to
resolve #313–#315 or #310's separate upload-limit follow-up.
