# Supported upload limits (#310)

CollectiveUI supports a configured file limit from 1 to 25 MB. The default remains 20 MB. The single-file `/api/files` route enforces the smaller of the saved limit and 25 MB; Next's proxy and server-action buffers remain bounded at 30 MB, leaving room for the file's multipart envelope. Admin and The Architect use the same validation schema and reject new limits above 25 MB with an explicit message.

## Existing configuration

A previously saved limit above 25 MB is retained in the database. This change does not migrate or rewrite that value, its timestamp, or any live configuration. Reads continue to return the saved value. Admin shows that value alongside a warning that uploads currently use 25 MB, and asks an administrator to choose and save a supported value. The Architect returns the saved `limits.uploadMaxMb` and its original `limitsUpdatedAt` revision, plus an `uploadPolicy` containing the supported and effective maxima and a legacy-value notice. Its replacement must use that original revision; stale writes remain rejected.

This bounds a setting whose larger values were already unusable through the proxy. It avoids increasing per-request body buffering to 500 MB. Saving a supported value is an explicit normal Admin or approved Architect action, rather than an automatic repair of stored settings.

## Web, iOS, macOS and Hermes

Web Composer and both native clients use `/api/files`; `CollectiveKit/APIClient.upload` constructs that request for iOS and macOS. The route returns HTTP 413 with the effective numeric limit for an oversized file or incomplete multipart body. A lower configured limit remains effective.

The separate personal remote-Hermes prompt route intentionally retains its existing smaller limits: at most 20 MB per file (or a smaller configured limit) and 25 MB for the whole multipart request. Its file-size errors now name the effective limit; incomplete multipart bodies return 413. Those native backend constraints are unchanged. File-count limits are unchanged.

## Verification

- `tests/unit/upload-limits.test.ts` checks Admin and Architect input bounds, the actual Next buffer configuration, rendered Admin legacy warnings, unchanged stored-setting behavior at the route boundary, web/native bearer-shaped file requests, a real 25 MB File and its sub-30 MB multipart envelope, smaller configured limits, and incomplete regular/Hermes multipart requests. Authorization, storage, extraction and native dispatch are synthetic boundaries. This test does not start the full Next proxy or an installed mobile app, establish live native authentication, or contact a Hermes server.
- `tests/unit/architect-admin.test.ts` uses production tool dispatch and migrated embedded PostgreSQL state. Its legacy-value regression verifies unchanged 500 MB storage, separate effective-policy reporting, rejection of an unsupported replacement without mutation, a supported replacement with the original CAS revision, and stale-token rejection. Unrelated pgvector columns use arrays in this fixture.
- Negative control: the new tests run against the previous production source in a separate worktree, exposing the previously accepted unsupported settings, missing legacy warning/policy, oversized-file acceptance, and generic Hermes error behavior.
- Typecheck, targeted ESLint and whitespace checks pass. Hosted CI and independent final-commit review remain merge gates.

No provider, deployment, account, credential or live security setting was changed.
