# LDAP identity, account locks, and mobile approval providers

Addresses issues #312, #313, #314, and #315. Repository fixes and disposable fixtures only; no real directory requests, account changes, provider configuration changes, credential revocation, or deployment were performed.

## Identity and lock invariants

- LDAP UPN comes from directory `userPrincipalName`, or directory `sAMAccountName`/`uid` plus the configured suffix. A typed email alias cannot become an account identifier. Missing directory identifiers fail closed. Existing alias-derived duplicate/orphan accounts are not automatically merged or deleted by this change.
- A saved LDAP binding is repaired only when fresh directory evidence has the same saved stable identity hash and canonical UPN. The hash still includes directory scope. A moved OU/CN may change DN; a recreated entry with a new UUID, a missing stable identity, a renamed UPN, or a different directory remains rejected. Passkeys, user handle, recovery codes, and session version are retained. Password login still requires enrolled factors; password reauthentication still requires the enrolled second factor.
- Passive reads and password reauthentication can relocate an outdated DN using bounded canonical UPN/account-name lookups. The lookup is a hint, never proof: the result must match the saved stable hash and canonical UPN, and AD status is reread at the candidate DN. Password verification binds the returned current DN. Direct password login supplies its freshly verified entry to the same guarded account path. No factor-reset or administrator-reset bypass was introduced.
- All LDAP round trips precede the installation-wide account transaction and advisory lock. The transaction then rereads account availability/version/realm/UPN/source, provider availability, and the exact saved DN/hash tuple. Any change during preflight rejects the operation. Directory group synchronization and DN updates use that same locked transaction. A slow directory does not retain a database connection or block an unrelated local recovery ticket.

## Mobile upgrade behavior

**Existing mobile codes and tokens without a recorded provider require fresh web approval after deployment.** Their original provider cannot be recovered safely from the user's latest sign-in source. They are rejected on use; no live revocation, data backfill, or provider inference is performed. Existing tokens that already record a known provider keep their normal expiry, account-version, revocation, and provider checks. Legacy web-session fallback is unchanged.

Auth.js exposes the authenticated JWT provider to its server-side session. Device approval requires that current web session's matching user/version, nonempty session ID, and known provider; form fields cannot select the provider. Code issuance checks the current account and provider again. Exchange burns providerless/unknown codes and asks for approval again; bearer authorization rejects providerless/unknown sessions. LDAP/Entra hybrid accounts remain bound to the method that approved each device, even if another method later updates `users.auth_source`. Disabling the original provider invalidates its device tokens.

## Automated evidence

The focused unit selection covers directory resolution/relocation, directory errors/groups, Auth.js callbacks, local auth/factors, mobile parameters/routes, web-session migration/revocation, and the destructive fixture target guard. The PostgreSQL suite runs production queries, transactions, advisory locks, factor enforcement, and actual mobile authorization/exchange/principal handlers. Only directory authentication and the already-verified web `auth()` result are synthetic.

Negative checks were executed before the corresponding repair, then the same regressions passed afterward:

| Issue | Before repair | After repair |
| --- | --- | --- |
| #314 | Two canonical-identity tests failed: an email alias became the UPN, and missing directory identifiers invented an account | Directory-derived UPN, alias sign-in/bound reads agree, missing identifiers rejected |
| #312 | Moved password login and reauthentication failed; passive relocation test failed separately | Same identity relocates while factors remain enforced; changed/missing identity and unbound factors rejected |
| #313 | While LDAP was paused, the independent PostgreSQL advisory-lock probe returned `false` | Probe succeeds and a local login ticket finishes before LDAP is released, with pool size **one**; eight concurrent account/binding/provider mutations reject stale evidence |
| #315 | Six PostgreSQL mobile cases failed; four session-provider callback cases failed | Hybrid provider identity is pinned; missing/unknown attribution and stale sessions rejected; legacy web fallback and known-provider tokens retained |

An additional local-provider approval case initially used the schema's temporary-password default; correcting the synthetic fixture to a permanent credential made the intended positive case valid. No production guard was relaxed.

Final local results: **106/106 focused unit tests**, **28/28 actual PostgreSQL auth/mobile tests**, and **10/10 existing local-factor PostgreSQL tests**. Typecheck, changed-file ESLint, and `git diff --check` also pass. PostgreSQL was portable **16.14**, pgvector **0.8.1**. The added hosted workflow uses pgvector PostgreSQL 17 and Node 22; that hosted result must be checked at the published head.

## Reproduce the dedicated PostgreSQL proof

Start a fresh loopback-only pgvector PostgreSQL service with user `fixture_auth`, password `synthetic-auth-only`, and database `collective_auth_identity_test`. Port 5432 below can be replaced with the port of that disposable service. Do not use a configured application database. The guard requires explicit opt-in, the exact database/user/synthetic password/loopback IP, an explicit port, no URL query/fragment, and no `PG*` connection overrides. The fixture migrates the schema and **truncates its fixture tables**. Application seed or installation configuration is not run.

```sh
AUTH_IDENTITY_POSTGRES_PROOF=1 \
AUTH_IDENTITY_POSTGRES_TEST_URL=postgres://fixture_auth:synthetic-auth-only@127.0.0.1:5432/collective_auth_identity_test \
DATABASE_URL=postgres://fixture_auth:synthetic-auth-only@127.0.0.1:5432/collective_auth_identity_test \
DATABASE_POOL_MAX=1 \
npx vitest run --project integration tests/integration/auth-identity.test.ts tests/integration/mobile-auth.test.ts --maxWorkers=1
```

The proof URL is separate from `DATABASE_URL`; there is no fallback to application credentials. The dedicated GitHub workflow provisions this exact disposable service and first exercises the pure guard without any DB imports.

## Platform coverage and limits

Web password/factor/settings flows use the corrected shared server paths. iOS and macOS share the same browser approval, PKCE exchange, and bearer APIs. Their shared `APIClient` invokes the unauthorized callback on bearer 401; `AppModel.handleUnauthorized()` clears the local session and displays “Your session has ended. Please sign in again.” This supports fresh approval for unattributed mobile tokens without a client schema change. Native token/provider logic was reviewed in source; no GUI, real iOS/macOS device, hardware passkey, real LDAP server, or real Entra session was exercised. The fake LDAP client tests cover lookup/bind/filter behavior; the PostgreSQL integration fixture models verified directory evidence rather than running an LDAP server. The real PostgreSQL lock proof is not a PGlite substitute.
