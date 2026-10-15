# Native Hermes workspace inspection

This follow-up to the native remote workspace adds **Workspace panels** at `/hermes/[connectionId]/operations`.

- Projects: native `projects.list`, including archived state and non-sensitive workspace folders. A selected, owned and idle native chat may prepare explicit, confirmed creation of an **empty inactive** project, or explicit selection of a non-archived project returned by the refreshed native list. The server generates project slugs and sends `folders: []`; the browser cannot submit paths or project identities that Hermes has not listed.
- Directories: native dashboard default working directory and project folders, followed by read-only `/api/fs/list`. Directory names are visible; file contents, downloads and filesystem mutations are unavailable.
- Schedules: read-only `/api/cron/jobs` for the selected native profile, including enabled state, schedule and next-run metadata. Prompts, commands, delivery credentials and execution output are omitted.
- Plugins: read-only `plugins.manage` list, with `plugins.list` fallback only when the newer method is unsupported. Configuration, schema values, server credentials and installation paths are omitted.
- System: bounded version, architecture, CPU, memory, disk and uptime fields from `/api/system/stats`. Hostnames, process identity, paths, environment values and raw config are omitted.

Every request requires the signed-in portal principal, an owned connection, the organization admission flag and a profile from the authenticated dashboard roster. Project mutations additionally bind an encrypted, short-lived confirmation to the owner, connection, server-owned chat/runtime/profile, and current socket epoch; they require an idle chat with no queued work or prompts. A durable one-shot receipt is written before dispatch, duplicate confirmations are never replayed, and project state is read back from Hermes before success is reported. Creating an empty project is separate from activating a project. Project selection changes the active project for the whole native profile, so the confirmation explains the profile-wide effect.

Profiles select native data within the dashboard account; they are **not portal tenant security boundaries**. Plugin and system panels describe the shared Hermes instance. This feature is for personal remote connections; managed/local and admin-shared backends require their own authorization and isolation integration.

HTTP routes and RPC methods are fixed server-side. Callers cannot provide arbitrary endpoints or methods. Existing pinned transport, redirect restrictions and encrypted server-owned credentials remain in use. JSON responses are limited to 1 MiB, projected rows to 500 and strings to bounded display lengths. Native errors are translated into generic panel errors without forwarding upstream response bodies.

Directory roots come from native working-directory/project metadata. The portal rejects hidden/sensitive paths, traversal, non-normalized paths and paths outside those roots. Each ancestor must appear as a real directory in a native parent listing; symlink leaves and invented descendants cannot be selected. Native root authorization and symlink behavior remain the remote dashboard's responsibility. Directory browsing is metadata-only and is not a filesystem sandbox.

Optional endpoints missing on older Hermes versions show an unavailable-panel error. The project browser falls back to the native working directory if `projects.list` itself is unsupported. No new database migration or runtime credential is required beyond the native remote connection prerequisites.

The project RPC capability is established by the pinned Hermes desktop contract (`f97608f178d1ffeca59860195ab7da295f7c8e5f`) and probed with `projects.list` on the current socket; unsupported methods fail closed. This increment does not add folder attachment, project editing/archive/deletion, arbitrary file-content access or editing, schedule mutations, plugin toggles/install/uninstall, or discovery-policy changes. Directory views remain metadata-only and do not claim to be a filesystem sandbox. Those operations need separately reviewed capability and workspace-authorization designs. Native root authorization and symlink behavior remain the remote dashboard's responsibility.

Validation:

```sh
npx vitest run --project unit tests/unit/remote-hermes-operations.test.ts tests/unit/remote-hermes-projects.test.ts
node tests/browser/remote-hermes-operations.mjs
npm run typecheck
```

Unit checks cover ownership/admission, profile validation, secret-free projections, hidden paths, directory ancestry and symlinks, fixed read-only directory transport, response bounds and unsupported-version errors. Project tests cover path-free empty creation, server-listed selection, profile matching, busy/uncertain session gates, fresh readback, one-shot receipts and ambiguous outcomes. The browser fixture uses synthetic data to verify the explicit two-step project confirmation and shared-profile warning alongside all five panels and directory navigation. It does not replace validation against a live dashboard.
