# Attachment lifecycle (#317)

Deleting one chat or all chats captures the actor's attachment IDs before message cascades, then removes only
owned files with no remaining message reference on any branch and no bot knowledge chunk. The mobile DELETE
endpoint uses the same action. Another user's file is never retired by this chat deletion.

Retirement locks each candidate attachment, checks references again in a fresh PostgreSQL statement, clears
extracted text and commits a `deleted_at` tombstone. Message/knowledge reference writers take a shared row lock
and refuse tombstoned or incomplete uploads. This closes the race between a new reference and cleanup. Missing
legacy file IDs continue to render as unavailable. The guard does not broaden file authorization.

Storage deletion happens after the transaction and the user admission lock have ended. Failure preserves the
attachment ID, owner and storage key for retry; metadata is removed only after successful/idempotent blob deletion.
The local adapter now ignores only ENOENT, rather than swallowing permission and I/O failures. Downloads (admins
included), model preparation, workspace import and knowledge ingestion all refuse tombstones/incomplete uploads.

Uploads record their storage key before writing bytes. A new `upload_complete=false` record is inaccessible and
remains recoverable if a write/extraction/process fails. The active upload holds only its own attachment row lock,
so cleanup skips it even if the grace interval passes while storage I/O is running. Legacy uploads default to complete.

The existing worker gains an hourly `attachment.cleanup` queue at minute 37. Each sweep handles at most 100
unreferenced rows, retries tombstones immediately and retires abandoned uploads after a **24-hour draft grace**.
Failed attempts rotate behind older unattempted orphans, avoiding starvation. Explicit chat cleanup batches all its
captured IDs. Multiple replicas may perform an idempotent delete; no arbitrary storage directory walk is performed.

Limits: an unsent draft left idle longer than 24 hours can lose its attachment and must upload again. A stopped
worker or storage outage delays physical removal; long backlogs take multiple bounded sweeps. Existing disk blobs
without any attachment metadata cannot be safely attributed by this sweep and are not deleted. Account deletion
and its existing user-row cascades are outside this chat-deletion change. Copies already downloaded/exported are
not revoked. Files still used as bot knowledge or by any stored message remain intentionally retained.

Migration `0069_attachment_lifecycle.sql` follows the reviewed index migration 0068. It adds only the two attachment
fields, three reference/cleanup indexes and the two reference-write triggers/functions. The generated snapshot
retains all seven 0068 indexes. Migration is exercised on a fresh PostgreSQL 16.14 + pgvector 0.8.1 database.

Verification uses only the exact opt-in disposable `127.0.0.1:55445/collective_attachments_test` database, synthetic
storage and temporary local-disk fixtures. No provider, GUI, production data/deployment, account or security settings
are accessed. Run after migrating the fixture:

```sh
ATTACHMENT_POSTGRES_PROOF=1 \
ATTACHMENT_POSTGRES_URL=postgres://fixture:synthetic@127.0.0.1:55445/collective_attachments_test \
node node_modules/vitest/vitest.mjs run --project integration \
  tests/integration/attachment-lifecycle-postgres.test.ts \
  tests/integration/shared-attachments-postgres.test.ts --maxWorkers=1 --configLoader runner
node node_modules/vitest/vitest.mjs run --project unit tests/unit/attachment-storage.test.ts --configLoader runner
```

The database suite covers single/delete-all/mobile ownership, other-message and knowledge retention, retry after
failure, orphan grace, message/knowledge concurrency, insert/update rejection after retirement, absence of locks
during slow storage I/O, all four reader classes, interrupted/active upload safety and more than one cleanup batch.
The sharing suite separately covers omission/copy/cutoff/revocation. Source typecheck and focused lint also run.

Negative control: restoring the original actions/routes/readers from `f197e1f`, retaining only compatibility columns
and indexes in 0069, and omitting the new triggers yields **8 failing, 1 passing, 5 skipped** selected lifecycle cases.
The failures include all three chat-delete paths, a concurrent message reference, post-tombstone reference admission,
both deleted/incomplete admin reads and the lost key after interrupted upload. The unchanged knowledge FK supplies
a lock in the passing case. Original local-disk catch-all error handling yields **1 failing, 1 passing** storage test.
All candidate files are automatically restored after each negative run.

Parity: iOS and macOS use the shared CollectiveKit DELETE conversation endpoint, so this server fix covers both.
No client UI was changed for deletion. Shared-view omission is web-only as documented for #318.
