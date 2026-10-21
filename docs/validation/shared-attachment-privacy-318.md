# Shared attachment privacy (#318)

Shared chat snapshots do not grant access to private upload URLs. The server removes file parts before sending
messages to the shared view, replaces them with a readable omission notice, and explains that continued copies
omit attachments too. Continue already filtered file parts; it now retains that explanation and recomputes search
text without stale filenames. Existing task-link and provider metadata stripping remain in place.

The snapshot still follows only the published cutoff's parent chain. Continue rechecks revocation inside its copy
transaction under a shared link-row lock, so a revocation committed after the initial lookup cannot be bypassed.
This does not retract a copy completed before revocation or bytes previously downloaded by an owner.

Parity: shared links currently have a web surface only (no share-link/create-share/snapshot implementation found in
the iOS or macOS source). Native chat files keep their existing authenticated owner/admin download behavior.
No attachment authorization was broadened and no running-app/GUI validation was performed.

`tests/integration/shared-attachments-postgres.test.ts` exercises the real server page and Continue action against
PostgreSQL 16.14 with a dedicated disposable database. Four checks pass: view stripping/notice/cutoff, copied
notice/search text/cutoff, revoked-link rejection, and revocation between initial lookup and copy transaction.
The page's client component is stubbed to inspect the server's returned props; this is not a visual UI test.

Negative control: restoring the three original source files from `69eb4403` while retaining these regressions gives
three failures and one pass. The failing cases expose the original file URL in the shared page, silent copy omission
with stale filename search text, and successful copy after intervening revocation. Candidate source passes all four.

Opt-in execution (migrate the disposable database first):

```sh
ATTACHMENT_POSTGRES_PROOF=1 \
ATTACHMENT_POSTGRES_URL=postgres://fixture:synthetic@127.0.0.1:55445/collective_attachments_test \
node node_modules/vitest/vitest.mjs run --project integration \
  tests/integration/shared-attachments-postgres.test.ts --maxWorkers=1 --configLoader runner
```

The fixture refuses other hosts, ports/database names, URL query parameters, and PostgreSQL environment overrides.
It uses only synthetic records, with no provider calls, GUI, production deployment, or account configuration change.
