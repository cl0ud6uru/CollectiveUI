# Workspace browser

Native chat headers offer a Workspace button to people in the enabled workspace audience. It opens a resizable right panel on desktop and an accessible dialog below 1100px. Opening bot details closes the workspace panel and vice versa; neither remounts the conversation or replaces a message draft.

Files are shared across the person's native bots and belong to the authenticated person. The panel does not select a bot, user, container reference or host path. External Hermes continues to use its own execution path.

## Files

- Expand folders, filter loaded entries, open multiple preview tabs, reload a preview, copy a path, download the original bytes, or add a path to the current message draft.
- Successful file tool results offer **Open** when the containing chat can open the workspace, alongside the existing download link.
- Text previews are UTF-8, read only, and limited to 256 KB. HTML and SVG are displayed as text, never executed. Other formats offer a download.
- Each upload is limited to 10 MB and saved under `uploads/<random-folder>/<original-name>`. Existing files are preserved. The UI reports the new path, which can be inserted into chat.
- Browsing an absent workspace does not allocate one. Browsing files in a stopped workspace can wake it through the existing file helper. A completed chat workspace tool refreshes the visible tree; previews also have a reload control.

## Terminal

The Terminal tab displays workspace command outputs from the current chat and a command runner for the person. This is a streamed command runner, not a persistent interactive PTY. Each direct command starts in the workspace root; shell state and `cd` do not persist between commands. Bot approvals remain in chat and are unaffected.

Clicking **Run** submits the exact entered command. The server requires authentication, same-origin requests, workspace access, fixed isolation policy, the existing hard-deny policy and the existing command/output limits. It creates a random execution ID and looks up the workspace from the session. No command text is written to the audit log. **Stop**, navigation, or cancellation closes the execution lifeline. Do not retry an interrupted command before checking its output.

## Routes

| Route | Operation |
| --- | --- |
| `GET /api/workspace/browser?operation=status` | Public readiness/state for the owner's workspace; no daemon reference |
| `GET /api/workspace/browser?operation=list&path=…` | Up to 500 immediate directory entries |
| `GET /api/workspace/browser?operation=preview&path=…` | Inert, bounded JSON text preview |
| `POST /api/workspace/upload` | Bounded multipart upload into a fresh folder |
| `POST /api/workspace/terminal` | Bounded JSON command request, NDJSON output stream |
| `GET /api/workspace/files?path=…` | Existing protected original-byte download |

All data responses use `private, no-store`. File reads and writes use the existing confined sandbox helpers, including their symlink/path validation. Query parameters cannot specify another owner or sandbox. Upload and command bodies are capped while being read rather than trusting Content-Length.

## Validation

`npm test -- --project unit tests/unit/workspace-browser.test.ts tests/unit/workspace-artifacts.test.ts` verifies route ownership, origin/path validation, limits, cancellation, inert previews and upload placement. `node tests/browser/workspace-browser.mjs` exercises the actual panel with synthetic data; add `--serve` to keep its preview on port 4197. This fixture does not sign into a live account or make model calls.

The optional `tests/sandbox/workspace-browser.test.ts` exercises the actual routes with synthetic authentication against a real sandboxd. It requires `SANDBOX_BROWSER_TEST=1`, `SANDBOX_BROWSER_URL`, and a private `SANDBOX_BROWSER_SECRET`; run with `npm test -- --project sandbox tests/sandbox/workspace-browser.test.ts`. It uses a random temporary workspace and cleans it up. Ensure test capacity is available before running against a shared daemon.
