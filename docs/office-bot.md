# Office Bot

Office Bot is a shared native caller bot for uploaded `.docx`, `.xlsx`, `.csv`, `.pptx`, and text PDF files. It creates and edits Word documents, Excel formulas/tables/charts, and PowerPoint presentations; it reads PDF text/tables, creates PDFs, merges/splits pages, and exports Office files to PDF. Results are downloadable copies in the person's own workspace. Every workspace command retains the existing enforced approval.

## Install

1. Build `npm run sandbox:image` on the sandbox host. Build-time network access is required for Debian packages and pinned Python packages; runtime workspaces remain offline.
2. Configure `SANDBOXD_IMAGE` to the resulting image **ID**, then restart sandboxd. Existing workspaces detect image drift on their next use and retain their volumes. Do not reset people's workspaces.
3. Confirm workspace access in Admin → Workspaces and that the workspace tool group is enabled in Admin → Bots & tools. Shared bot visibility does not grant workspace access to excluded users.
4. Open Admin → Bots, select a public organization model with native tools, and click **Add Office Bot**. The installer probes a fresh temporary workspace and cleans it up before enabling the bot. Missing Office packages, image/service problems, or unavailable isolation prevent installation.
5. Open Office Bot, upload a file of at most 10 MB, and describe the desired result. Approve the explained processing command, then download the finished copy.

The installing admin owns the bot. Its receipt is stored under the `officeBot` setting. Concurrent or repeated installation returns the same bot and preserves edits/disabled state. Deletion retains the receipt: the installer refuses automatic replacement until an administrator explicitly resolves it. No schema migration or automatic permission change is added.

## Processing

The native model sees authorized attachment IDs alongside existing extracted text. `workspace_import_attachment({attachmentId})` independently verifies ownership and a user-authored file part in the current owned conversation. It reads original bytes from attachment storage, enforces the 10 MB limit on metadata and actual bytes, sanitizes the filename, and writes under `uploads/<attachmentId>/<filename>`. Duplicate filenames have separate paths. Re-importing preserves an identical copy and refuses to overwrite a changed copy.

The sandbox has `/opt/office/bin/python` with pinned `python-docx`, `openpyxl`, `python-pptx`, `pypdf`, `pdfplumber`, and `reportlab` packages. Use `/opt/portal/office-check` to verify availability. The Python environment is intentionally explicit; standard workspace Python and portal helpers remain unchanged.

`/opt/portal/office-convert INPUT --to pdf|xlsx --outdir DIRECTORY [--timeout SECONDS]` runs LibreOffice with a separate temporary profile and maximum macro security. It confines input/output to the workspace, refuses overwrite and outputs inside `uploads/`, caps timeout at 90 seconds, and checks for a nonempty output within the 10 MB download limit. XLSX output is available only for Excel/CSV input. The bot writes results to unique folders under `office-output/` and obtains download URLs through `workspace_read` and the existing caller-owned download endpoint.

Excel formula evaluation uses LibreOffice; openpyxl does not evaluate formulas. Verify recalculated values by reopening with `data_only=True`. Recalculation/export may change complex workbook features, and Office conversion is not a guarantee of exact Microsoft Office rendering. PDF table extraction depends on page layout. Unsupported features must be reported rather than silently claimed as preserved.

Microsoft 365 accounts, legacy Office formats, VBA, Power Query, pivot-table authoring, scanned-PDF OCR, and PDF forms are outside this version. Corrupt or encrypted inputs and conversion timeouts return actionable failures. Existing workspace memory/CPU/timeout limits still apply; start with the normal 2048 MB workspace allocation and test representative documents before rollout.

## Verify

The `Office Bot` GitHub workflow runs installation/import tests on an isolated `collective_office_bot_test` Postgres database, then builds the image and tests actual Word, Excel, PowerPoint, and PDF files in fresh offline sandboxes. No model endpoint or customer files are used.

Run the relevant suites locally:

```sh
npx vitest run --project unit tests/unit/office-policy.test.ts tests/unit/workspace-toolset.test.ts tests/unit/workspace-artifacts.test.ts tests/unit/hermes-native-attachments.test.ts
DATABASE_URL=postgres://postgres:office-test-only@127.0.0.1:5432/collective_office_bot_test npm run db:migrate
DATABASE_URL=postgres://postgres:office-test-only@127.0.0.1:5432/collective_office_bot_test npx vitest run --project integration tests/integration/office-bot.test.ts
SANDBOX_DOCKER=1 npx vitest run --project sandbox tests/sandbox/office-files.test.ts
```

For a separately tagged test image, set `OFFICE_TEST_IMAGE` for the sandbox suite. Its harness creates and removes only its own labeled containers and volumes.
