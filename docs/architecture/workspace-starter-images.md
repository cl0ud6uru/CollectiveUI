# Workspace starter images

W3 supplies two reviewed image recipes in `docker/workspace-templates/manifest.json`. They are Linux-only, use the existing sandbox helper contract, run as uid/gid 1000, and have no runtime network access when started by sandboxd. `agentBrowserView` stays false because these images do not provide an agent browser session or viewer.

## Profiles

| Versioned profile key | Template slug (`--only`) | Catalog name | Included capabilities |
| --- | --- | --- | --- |
| `knowledge-work-v1` | `knowledge-work` | **Knowledge Work** | Shell, Python, headless LibreOffice writer/calc/impress, existing checked conversion helpers |
| `dotnet-linux-v1` | `dotnet-linux` | **.NET Linux** | Shell, Microsoft .NET SDK 10.0, a locked console starter and pre-restored NuGet cache |

Knowledge Work reuses `docker/sandbox/office-requirements.txt`, `office-check`, `office-convert`, and the existing runner/file helpers. It provides headless document conversion only; it has no desktop session, GUI or browser viewer. Its seed is created from the manifest and copied with no-clobber semantics into a persistent home.

The .NET image uses the digest-pinned `node:22-bookworm` Linux base and installs the exact Microsoft `dotnet-sdk-10.0` Debian package `10.0.112-1` (CLI SDK `10.0.112`, runtime `10.0.12`). The Docker build verifies the SDK, runtime, reference pack, and Linux apphost pack against those manifest versions; the health check rechecks the SDK and runtime. Microsoft lists .NET 10.0.12 as active LTS through November 14, 2028; Debian 12 is the Linux distribution used here. See the [official .NET support policy](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core) and [Microsoft Debian package repository](https://packages.microsoft.com/debian/12/prod/).

The starter targets `net10.0` and pins `Newtonsoft.Json` 13.0.3 in `packages.lock.json`. The image build performs the only NuGet restore, using the explicit public NuGet v3 feed and `--locked-mode`; it then stores the restored package cache and restore metadata in the image. At first start, the entrypoint seeds only missing starter and package-cache files. It does not replace existing workspace or cache files. From a fresh home, `dotnet build --no-restore` and `dotnet run --no-restore` need no runtime package feed. New package references require a new reviewed template image and lock file.

This preset targets modern .NET on Linux. It makes no .NET Framework, Windows Desktop, WinForms, WPF, COM or Windows-only API claim.

## Build and record local image IDs

Run from the repository root:

```sh
scripts/build-workspace-template-images.sh
```

The script uses the repository root as Docker build context so the existing helpers can be copied without changing `docker/sandbox/Dockerfile` or `npm run sandbox:image`. Docker build networking is enabled only while apt, pip and NuGet dependencies are fetched. The running sandbox still uses the existing `NetworkMode: none`; the script never pushes images or changes compose/deployment/security settings.

The output includes Docker image IDs (`sha256:…`), which are immutable references local to this Docker host. To record the built IDs in the manifest explicitly:

```sh
scripts/build-workspace-template-images.sh --record-image-refs
```

The manifest's `imageRefStatus` distinguishes a recorded local build from one still requiring a build. For a single image, pass `--only knowledge-work` or `--only dotnet-linux`, with `--record-image-refs` only when that reviewed profile is ready to update. Review the manifest diff and retain its version when rebuilding identical inputs; increment the profile version when changing seed content, capabilities, SDK/package inputs or helper behavior. Local image IDs are not registry references and are not pushed or published by this workflow; the target host must build or load the reviewed image before a profile can be admitted.

## Install profiles in sandboxd

The manifest records build evidence; it does not configure the running daemon. Set
`SANDBOXD_PROFILE_IMAGES` in sandboxd's own environment to a JSON object mapping
`knowledge-work-v1` and/or `dotnet-linux-v1` to the full `sha256:` image IDs
installed on that Docker host, then restart sandboxd through the normal operator
process. The optional Compose sandbox overlay passes this setting only to
sandboxd. The legacy `SANDBOXD_IMAGE` setting is independent.

Unknown profile keys, mutable tags and incomplete IDs fail configuration parsing.
`GET /v1/health` reports each supported template profile's `installed` state and
verified image ID. The portal uses that authenticated report for assignment;
its static profile definitions validate recipe capabilities and starter bundles,
and never act as a second image installation registry. Missing profiles or older
daemon health reports leave template assignment unavailable while legacy
workspaces continue to work. Sandbox startup rechecks the daemon's configured
image and preserves existing profile labels, limits and network isolation.

## Instance retention

Each owner can retain at most 32 template instances, including current bindings,
provisioning reservations and failed or replaced instances. The legacy personal
workspace is independent of that limit. Reusing the currently bound version does
not create a reservation and remains available at the limit.

New reservations persist a cleanup deadline before sandbox creation. A successful
assignment clears that instance's deadline and schedules any previous unbound
template instances in the same transaction. Failed starts retain their deadline;
the hourly sweep also backfills old unbound/crashed instances. Deadlines use the
administrator's existing `deleteAfterDays` policy (default 30 days; zero means
cleanup on the next sweep). Files persist until that deadline, and unused
instances count toward the limit until removed. Re-enabling an account clears
deadlines only for its legacy workspace and currently bound instances, preserving
unused-template cleanup. A template still bound to another bot is protected.
An unused template's retirement date never becomes the retention deadline for a
disabled account's currently bound workspaces.

## Checks

`node tests/browser/admin-primary-contrast.mjs` renders the actual starter-catalog and Office Bot controls with production CSS in light and dark themes. Synthetic held actions verify pending labels, unavailable-model labels and disabled single-submit behavior without changing settings or starting a workspace.

The sandbox test file always checks the manifest, digest-pinned base, profile capabilities, Linux target, lock file, helper reuse and first-start no-overwrite commands. Real image checks use the normal sandbox harness, which runs with a read-only root filesystem, dropped capabilities, a private persistent home volume and no network. Run them after building and recording the images:

```sh
SANDBOX_DOCKER=1 npx vitest run --project sandbox tests/sandbox/workspace-starter-images.test.ts
```

Those checks cover helper uid/permissions, the Office conversion fixture, no-restore .NET build/run from a fresh volume, restart persistence and a clear missing-image error. They do not deploy or create production profiles.
