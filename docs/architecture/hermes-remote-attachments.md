# Remote Hermes original attachments

Shared remote profiles use the Runs API, which does not natively stage arbitrary original documents. This integration adds a dedicated file transport to upstream commit `47676981f55de91231fdeef2f0eec47e7c209e78`. It does not enable browser control or reuse its short-lived artifacts.

## Delivery contract

1. CollectiveUI resolves only attachments owned by the conversation owner and preserves original bytes for the newest user turn. Extraction success and model vision flags do not determine whether a file is delivered.
2. The client requires `features.run_attachments.version === 1`, an explicit conversation ID, and the existing session-key header. Unsupported servers fail before any file upload or prompt submission.
3. Files upload sequentially to `POST /p/<profile>/v1/attachments`. The body is binary. Headers include profile Bearer authentication, MIME `Content-Type`, percent-encoded `X-Hermes-Filename`, `X-Hermes-Session-Id`, `X-Hermes-Session-Key`, and a stable per-file `Idempotency-Key`.
4. Each receipt contains `{id, sha256, size, name, media_type}`. The client verifies the complete receipt against the original file before submitting `{input, session_id, file_ids}` to Runs. Raw file bytes and API credentials are not inserted into model text.
5. The server resolves every ID under the same authenticated profile, API-key identity, session ID, and session key before inference. It checks regular-file status, size, and SHA-256, then appends a JSON manifest of generated local paths. Names and file contents are explicitly described as untrusted data. Normal file tools can read the originals.

## Storage and limits

Files and SQLite receipts live below the profile directory in `attachments/collectiveui`. Files use generated IDs and MIME-derived extensions; supplied filenames are metadata and cannot choose paths. Unknown, well-formed MIME types remain opaque `.bin` files. PDFs, legacy Word documents, DOCX documents, images, and text retain appropriate extensions. File contents are never executed or decoded by the transport.

Storage follows the gateway's context-selected `get_hermes_home()`, including named single-profile gateways and multiplexed request scopes. Receipt identity uses the routed profile when present, otherwise the canonical profile owning that home. Bare and matching `/p/<name>` routes on a single-profile gateway therefore share the same originals and receipts within that gateway's home.

The limits are eight files per turn, 8 MiB per file, 16 MiB per turn, and 256 MiB or 1,024 files per conversation. Stable upload identities make retries idempotent; changed bytes or metadata under an existing identity are rejected. Receipts survive service restarts, and files are reusable across follow-up turns. There is no one-shot consumption or automatic expiry. Operator-approved cleanup after conversation deletion must remove retained originals and receipts; this adapter does not delete conversation data automatically. API-key rotation revokes access to receipts bound to the previous key identity.

The gateway's existing profile authentication and routing remain authoritative. Profiles are not OS tenant isolation: processes with the same filesystem permissions can still read the same files. This adapter only binds API file references; it does not introduce a new filesystem security boundary.

## Installation and rollback

The installer does not connect to a server, change secrets or configuration, install dependencies, or restart services. Run it as the account that owns the remote source. A clean target and the exact upstream commit are required; future Hermes updates require a reviewed port.

From a trusted CollectiveUI checkout, validate first:

```sh
python3 scripts/install-hermes-attachments.py --hermes-source /path/to/hermes-agent
```

After reviewing the result and arranging deployment, apply:

```sh
python3 scripts/install-hermes-attachments.py --hermes-source /path/to/hermes-agent --apply
```

The installer backs up the two integration files in a generated `collectiveui-attachment-backup-*` directory inside the Hermes checkout and copies the adapter module. It changes neither systemd nor profile settings. Validate Python imports with the Hermes runtime interpreter before a separately authorized gateway restart. After restarting, verify the capability flag on the intended profile and perform a synthetic upload/run test before sending real documents.

To roll back, restore `gateway/platforms/api_server.py` and `gateway/platforms/api_server_runs.py` from that backup and remove `gateway/platforms/api_server_attachments.py`, then arrange another gateway restart. Retained attachment data is unaffected by source rollback. Never overwrite subsequent upstream or operator edits when restoring a backup.

## Validation

Standard-library tests cover byte retention, profile/session/key binding, replay-safe uploads, conflicting identities, filenames, quotas, MIME validation, corruption, symlinks, and installer dry-run/apply guards. Portal tests cover sequential staging, receipt verification, files-only turns, unsupported servers, and inference suppression after delivery failures. The isolated aiohttp test sends original bytes through the real client and adapter over HTTP and proves they can be read at the generated agent paths. It uses synthetic files and profiles and does not call a model.

CI also validates installer integration points against the exact upstream checkout. A live gateway restart and real-model parsing of each document format are deployment checks, not claims made by the synthetic tests.
