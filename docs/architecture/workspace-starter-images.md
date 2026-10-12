# Workspace starter images

W3 supplies two reviewed image recipes in `docker/workspace-templates/manifest.json`. They are Linux-only, use the existing sandbox helper contract, run as uid/gid 1000, and have no runtime network access when started by sandboxd. `agentBrowserView` stays false because these images do not provide an agent browser session or viewer.

## Profiles

| Profile key | Catalog name | Included capabilities |
| --- | --- | --- |
| `knowledge-work` | **Knowledge Work** | Shell, Python, headless LibreOffice writer/calc/impress, existing checked conversion helpers |
| `dotnet-linux` | **.NET Linux** | Shell, Microsoft .NET SDK 10.0, a locked console starter and pre-restored NuGet cache |

Knowledge Work reuses `docker/sandbox/office-requirements.txt`, `office-check`, `office-convert`, and the existing runner/file helpers. It provides headless document conversion only; it has no desktop session, GUI or browser viewer. Its seed is created from the manifest and copied with no-clobber semantics into a persistent home.

The .NET image uses the digest-pinned `node:22-bookworm` Linux base and installs the exact Microsoft `dotnet-sdk-10.0` Debian package `10.0.112-1` (CLI SDK `10.0.112`, runtime `10.0.12`). Microsoft lists .NET 10.0.12 as active LTS through November 14, 2028; Debian 12 is the Linux distribution used here. See the [official .NET support policy](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core) and [Microsoft Debian package repository](https://packages.microsoft.com/debian/12/prod/).

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

The checked-in manifest marks each `imageRef` as `build_required` until a successful local build is explicitly recorded. A profile with a null image reference is not ready for admission. For a single image, pass `--only knowledge-work` or `--only dotnet-linux`, with `--record-image-refs` only when that reviewed profile is ready to update. Review the manifest diff and retain its version when rebuilding identical inputs; increment the profile version when changing seed content, capabilities, SDK/package inputs or helper behavior. Local image IDs are not registry references and are not pushed or published by this workflow; the target host must build or load the reviewed image before a profile can be admitted.

## Checks

The sandbox test file always checks the manifest, digest-pinned base, profile capabilities, Linux target, lock file, helper reuse and first-start no-overwrite commands. Real image checks use the normal sandbox harness, which runs with a read-only root filesystem, dropped capabilities, a private persistent home volume and no network. Run them after building and recording the images:

```sh
SANDBOX_DOCKER=1 npx vitest run --project sandbox tests/sandbox/workspace-starter-images.test.ts
```

Those checks cover helper uid/permissions, the Office conversion fixture, no-restore .NET build/run from a fresh volume, restart persistence and a clear missing-image error. They do not deploy or create production profiles.
