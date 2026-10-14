# Mac ChatGPT companion validation

This change follows the independently reviewed runtime-preparation prerequisite, PR #208 at `ac1e8fbb4632d02d45192e7ad715f9118953840d`. It adds an optional Mac launcher and an encrypted native transfer into the existing unified credential store. It remains disabled by default. The unsigned local build is a review artifact; release distribution and live OAuth acceptance require separate authorization and operator-controlled signing/notarization.

## Evidence

- 352 tests passed across 35 Mac-compatible account, SIWC, companion, policy, broker, proxy and migration suites. This includes the real native client and loopback callback composed with the HTTP receiver, cryptographic transfer, shared credential commit and source token removal.
- Transfer regressions cover signed custody acknowledgements, lost completion replies, replay, tampered envelope/snapshot, strict owner proofs, native/browser cancellation, session/disabled/policy/credential/expiry changes, signed email mismatch, pending-only bulk disconnect/user disable, failed broker clearing and delayed receive after negative recovery. Native account success survives separate Codex synchronization failure.
- Reconnect regressions cover persisted issued registration after VM Disconnect, origin/owner/host isolation, fresh PKCE/state/nonce, subject mismatch and server registration precedence. Cache persistence precedes local token removal; injected failure retains suspended recovery and an injected crash after cache persistence preserves registration for a new attempt.
- Real web-proxy tests cover the exact capability-authenticated native path, rejection of missing capability/browser cookies, and continued session requirements for adjacent routes. Initial Linux CI exposed the omitted proxy declaration and a false credential-writer match in the binding digest; both were corrected without adding a credential-store writer. The initial full Linux run passed 2,982 tests and failed only those two guards.
- Mac storage tests compile their own temporary Swift helper, then verify owner-only permissions, traversal/symlink refusal, atomic storage and kernel lock release after process exit. They do not invoke a GUI or depend on a prebuilt bundle. Linux CI skips only these native tests.
- Typecheck and targeted ESLint pass. Migration tests verify the 0056→0057 snapshot chain, preserved tables, foreign-key ownership, hashed capability fields, bounded expiration and one active attempt per owner.
- Disposable headless HTTPS browser fixtures exercise download/consent/launch/cancel/status refresh and truthful completion labels across 320/390/768/1280 pixel widths. The retained saved-connections fixture also passes. Browser profiles and account data are synthetic.
- The Mac bundle compiles and passes plist validation. Its packaged Node executable links only macOS system libraries. No GUI launch, installation, LaunchServices registration, certificates, Keychain access, signing or notarization was performed.
- Independent Sol 6.1 server review and Luna full-flow review found no remaining concrete blockers after the recovery fence and historical-completion UI corrections. Uncertain transfers may retain suspended source material for support/recovery; they never resume local refresh automatically.

The broader attempted Mac run also included three existing Linux-specific suites. Forty cases failed on `/proc` descriptor/namespace paths and unavailable `127.0.0.2` binding, with one consequent timeout/unhandled rejection in the old Linux storage suite. Those assumptions were not changed. The 35-suite command below excludes those Linux suites; Linux CI remains responsible for validating them.

```sh
node node_modules/vitest/vitest.mjs run --configLoader native --project unit tests/unit/chatgpt-*.test.ts tests/unit/personal-codex-*.test.ts tests/unit/web-session-migration.test.ts tests/unit/authz-coverage.test.ts tests/unit/policy-guards.test.ts --exclude tests/unit/personal-codex-egress-proxy.test.ts --exclude tests/unit/personal-codex-process-proof.test.ts --maxWorkers=2
npm run typecheck
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node tests/browser/personal-codex.mjs
node --import tsx scripts/build-chatgpt-companion.mts --origin https://collectiveui.test
```

The final origin above is a synthetic review origin. Release builds must use the operator's actual exact HTTPS origin.

## Preserved state

The main checkout's 26 saved files remain byte-identical to the post-iOS backup manifest (`473f8741f5bf380e9910063f7e2e73c8048218cb901ee7305cf4df859ec12878`). All implementation is in the separate `feat/chatgpt-sign-in-companion` worktree. No live identity, credential, enrollment, broker setting, deployment, VM or host-security setting changed.

Stock runtime image files are unchanged from the prerequisite. The previously verified image remains `sha256:28dd9f29a1bedb857b980c754bcce4ab0927ec0d8345f08e58ff63d0b662b8de`; requirements SHA256 remains `745a4740a6092ac7ffdfd4d2c9e2f16a86cdc718042eb112d864d749a5d0be09`. No Codex source rebuild occurred. Native application packaging does not alter the stock runtime image.
