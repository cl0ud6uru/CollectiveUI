# Deploying published CollectiveUI images

This optional path runs the core web, worker and PostgreSQL stack on **Linux amd64** without building application images on the VM. It uses public Docker Hub repositories and ordinary GitHub-hosted Ubuntu runners. The existing source-build Compose path remains available. Workspace, personal Codex, sandboxd and Hermes runtime images/add-ons remain separate operator installations; this updater supports only the stock core stack and its named volumes.

## Release owner setup checklist

These are operator setup steps; adding the workflow does not configure credentials or publish anything.

1. Confirm the actual Docker Hub account/organization namespace and create **public** `collectiveui-web` and `collectiveui-worker` repositories there. GitHub ownership does not establish Docker Hub ownership. No namespace is supplied by default.
2. Protect `main` with required review and checks. Create the GitHub environment `dockerhub-publish`, restrict it to reviewed `main` and approved `v*` release tags, and require an independent reviewer before publication. The workflow checks main ancestry; branch ancestry alone cannot prove human review. Environment protection and reviewed branch/tag creation provide that boundary. This PR does not change repository permissions or protections.
3. In that environment, the authorized owner supplies `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` with write access to only the intended repositories, using the narrowest token Docker Hub supports for the account. Keep credentials out of repository files and VM application `.env` files. VM pulls of public images do not require these publishing credentials.
4. Set repository variables `DOCKERHUB_NAMESPACE` to the confirmed namespace and `DOCKERHUB_PUBLISH_ENABLED` to `true` only when publication is approved. Missing enablement skips publication; a missing/invalid namespace fails before registry login. Leave the toggle unset during review.
5. For a stable release, publish a reviewed GitHub release tagged `vN.N.N` at a commit already on `main`, with migration/policy notes. Drafts, prereleases, off-main tags and noncanonical versions are refused. Test restoration in an isolated installation before an operator rollout.

The workflow builds web and worker once per event, runs typecheck/lint/unit tests, operator-tool tests, the worker dependency audit and disposable production image smoke tests, then exports the exact tested image IDs. The publishing job rechecks event revision/main ancestry, loads and verifies those IDs and labels, and pushes without rebuilding. PR runs receive no registry credentials and cannot enter publication. Actions are pinned to reviewed revisions.

Main pushes use `sha-<full 40-character commit>` tags; stable releases use `vN.N.N` tags. A release event builds and tests its own images, so its digests may differ from a previous main build of the same commit. Do not infer equivalence from tags or the unchanged npm package version. There is no mutable `latest` tag. Existing tags are refused, including reruns and partially published pairs. If one push succeeds and the next fails, no complete manifest is produced: investigate/review the partial publication and use a new version rather than overwriting a tag.

After both pushes, the workflow records the registry digests in one `release-manifest.json`. Main manifests are Actions artifacts retained for 90 days; version manifests are also attached to the GitHub release. Archive main manifests for longer retention if needed. Docker Hub tags are mutable by default; enable [immutable tags](https://docs.docker.com/docker-hub/repos/manage/hub-images/immutable-tags/) when available. Deployment always uses `@sha256` references regardless of tag settings. Treat the manifest as trusted release metadata obtained from the intended repository/run, not an arbitrary download. Digests identify content; they are not publisher signatures.

## First image installation

Prerequisites: Linux amd64, Docker Engine, Compose v2 supporting `up --wait` (2.24+), Python 3.11+, Git with a full reviewed checkout containing both current and target release commits, sufficient disk for images plus database/uploads backups, operator Docker access, HTTPS/reverse proxy and a maintenance window. A shallow checkout is insufficient for updates between revisions; fetch complete reviewed history before running the updater. Buildx is required on the publishing runner, not for VM pulls. The updater never installs packages, changes daemon settings, creates credentials or grants the web app socket access.

Keep an operator checkout of the reviewed release source (the scripts and Compose file), download its trusted manifest and prepare runtime configuration:

```bash
# In the reviewed checkout, on the VM:
cp .env.example .env
chmod 600 .env
mkdir -p certs
# Edit .env: unique POSTGRES_PASSWORD, AUTH_SECRET, ENCRYPTION_KEY,
# AUTH_URL, sign-in providers and any integration settings.
# Usually WEB_BIND=127.0.0.1 when the host proxy terminates TLS.
```

Use an explicit namespace and project. For a **fresh** installation the example project is `collectiveui`; for an existing installation use its **actual** Compose project name. Choosing a different name creates different volumes and can look like lost data.

```bash
DOCKERHUB_NAMESPACE='SET_THE_CONFIRMED_NAMESPACE'
python3 scripts/deploy-release.py \
  --directory "$PWD" --project collectiveui --namespace "$DOCKERHUB_NAMESPACE" \
  apply /secure/path/release-manifest.json
```

The updater restricts interpolation to `.env` and its explicit digest references; ambient exported application variables cannot override recorded configuration. Before downtime it verifies any existing DB's volume, supported PG16 image and, when running, actual PostgreSQL 16/pgvector availability. It pulls/inspects both images, confirms labels/platform, journals the operation, stops web/worker, starts or preserves PostgreSQL, repeats the live DB check, backs up DB/uploads, migrates once, and waits for healthy worker then web. Unsupported databases require a separately backed-up database migration. The updater neither rebuilds images nor upgrades an existing database container. Images contain application code only; `.env`, certificates, database data, upload data and updater backups are excluded from image builds.

For interactive bootstrap and other Compose operator commands, extract the manifest's two digest references as data (never `eval` downloaded content):

```bash
export COLLECTIVEUI_WEB_IMAGE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["images"]["web"])' /secure/path/release-manifest.json)"
export COLLECTIVEUI_WORKER_IMAGE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["images"]["worker"])' /secure/path/release-manifest.json)"
docker compose --env-file .env -p collectiveui -f docker-compose.release.yml config --quiet
# Local-account installation only: follow the existing interactive bootstrap instructions.
docker compose --env-file .env -p collectiveui -f docker-compose.release.yml \
  run --rm -e LOCAL_AUTH_OPERATOR=bootstrap worker npm run local-account -- bootstrap
```

See [local-account setup](operations.md#standalone-vps-with-local-accounts). The worker image also bundles the existing Sign in with ChatGPT owner helpers from main; follow [the documented sign-in/profile import workflow](connections.md#peoples-own-chatgpt-plans-sign-in-with-chatgpt) as a separate authentication operation. Use `node --import tsx scripts/chatgpt-import.ts` in the worker with the protected profile supplied at runtime; the native npm alias expects a host `.env.local`. Keep profile exports outside the checkout/build context; `chatgpt-profile*.json` files are explicitly excluded from images. The release/updater performs no sign-in or enrollment. Keep publishing credentials off the VM. Verify browser sign-in, a direct worker-backed chat, existing files/logos and bot permissions before admitting users. Container health establishes database reachability and worker initialization, not provider/inference or end-user functionality.

## Existing source-build installations

First back up the current database, uploads, runtime `.env`/encryption keys, certificates, Compose configuration and revision; rehearse restoration. Identify the current project and **both** actual volume names using local container inspection. The new file uses the same `pgdata`/`uploads` names under an explicit project. Custom mounts, managed/external databases, scaled applications, add-ons, changed database versions and custom overrides require a separately reviewed runbook; the stock updater rejects them.

An untracked running application cannot be updated automatically: its previous digest pair is unknown. Before the manual transition, inspect the actual database image (it must be `pgvector/pgvector:pg16`, optionally digest pinned) and query the running server. With the existing project's configuration, run `psql -X -At -U portal -d portal -c "SELECT current_setting('server_version_num'), EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector');"` through `docker compose exec -T db`; expect a PostgreSQL 16 version number such as `160014|t`. A PG14/PG15 database or missing pgvector requires a separately backed-up database migration before proceeding. Changing the Compose image field does not upgrade the existing server or its data.

During the first manual transition, pull the manifest's digest pair, stop both old services, preserve the verified PG16 DB and volumes, run the new `migrate` service, then start the new healthy pair:

```bash
# With the digest-reference exports above and the ACTUAL existing project name:
docker compose --env-file .env -p collectiveui -f docker-compose.release.yml pull web worker
docker compose --env-file .env -p collectiveui -f docker-compose.release.yml stop web worker
# Existing db is preserved: no database image/version replacement.
docker compose --env-file .env -p collectiveui -f docker-compose.release.yml \
  up -d --no-recreate --wait db
docker compose --env-file .env -p collectiveui -f docker-compose.release.yml \
  --profile maintenance run --rm --no-deps migrate
docker compose --env-file .env -p collectiveui -f docker-compose.release.yml \
  up -d --no-build --no-deps --wait worker web
python3 scripts/deploy-release.py \
  --directory "$PWD" --project collectiveui --namespace "$DOCKERHUB_NAMESPACE" \
  adopt /secure/path/release-manifest.json
```

Execute subsequent lines only after each command succeeds. If migration/readiness fails, stop both services and recover from the manual consistent snapshot; do not start the old worker against the changed database. `adopt` only records a manifest after verifying actual image IDs, volumes, supported database image/live major and health. It does not migrate or change services. Automated snapshots begin with the next `apply`.

## Updating, interruption and rollback

Use the same directory, project, namespace, Docker daemon, runtime `.env` and stock Compose file with the next trusted manifest. Runtime configuration changes require a separate manual reconciliation; the updater binds its installation to the original `.env` fingerprint so the previous image pair cannot be rolled back with silently changed credentials. Replacing the stock Compose contract or changing storage/daemon identity is a separate operator migration, not an ordinary updater run. Keep secrets/configuration stable during an update; a changed `.env` blocks rollback until the matching configuration is restored securely. The migration fingerprint identifies bundled migration files; **it does not promise downgrade compatibility**. Migrations also install pets, and workers initialize queues and rewrap stored credentials.

`apply` accepts forward releases only: stable versions must increase, and a different source revision must descend from the current commit in the local complete Git history. Older or divergent commits are refused before pulls/downtime. The exact current manifest is a healthy no-op. A differently named release of the same commit can be used when its migration fingerprint agrees, but reusing the same version with changed metadata is refused. Fetch reviewed history explicitly when needed; the updater performs no network Git operations. Use the explicit snapshot restore below for a downgrade, even when an old manifest is otherwise valid.

The private `.collectiveui-deploy` directory holds atomic state, an exclusive operation lock, journals, custom-format PostgreSQL dumps and gzip uploads archives with checksums. Backups are made while web/worker are stopped, checked, and fsynced along with their directory entries before the journal permits migration. They are sensitive and consume disk: archive them to protected storage, back up encryption/session secrets and certificates separately, test restores, and prune only deliberately after retention requirements are satisfied. Never commit/publish these files or use `docker compose down -v` during upgrade/recovery.

```bash
python3 scripts/deploy-release.py --directory "$PWD" --project collectiveui \
  --namespace "$DOCKERHUB_NAMESPACE" status
```

An unfinished journal blocks another update. Ordinary errors, Ctrl-C and SIGTERM attempt to stop both applications and labeled maintenance helpers. A killed process, power loss or Docker outage may leave containers running: isolate ingress, inspect the journal/containers and use the recovery command before more work. No application is automatically downgraded.

If the journal shows `prepared`, `backing-up` or `backed-up` and a previous pair is known, `recover` fences helpers and restarts that pair **only before any migration began**:

```bash
python3 scripts/deploy-release.py --directory "$PWD" --project collectiveui \
  --namespace "$DOCKERHUB_NAMESPACE" recover
```

Once migration begins, recovery requires a consistent snapshot. The explicit command below is destructive: it stops applications/helpers, validates the DB volume and checksums, **drops/recreates the fixed `portal` database**, restores DB and uploads, and starts the recorded previous pair. Writes since the snapshot are lost. Restoration cannot undo provider/tool side effects or upstream token rotation; verify connections and reconnect when necessary. It requires matching runtime secrets/configuration and a known previous release; an initial installation without a previous pair needs manual recovery.

```bash
# Failed update: deliberately restore its complete snapshot.
python3 scripts/deploy-release.py --directory "$PWD" --project collectiveui \
  --namespace "$DOCKERHUB_NAMESPACE" rollback --restore-data

# Successful update: deliberately select its retained snapshot receipt.
python3 scripts/deploy-release.py --directory "$PWD" --project collectiveui \
  --namespace "$DOCKERHUB_NAMESPACE" rollback \
  --backup "$PWD/.collectiveui-deploy/backup-REPLACE_WITH_RECORDED_ID" --restore-data
```

Do not manually remove the pending journal to bypass recovery. If a backup is incomplete/corrupt, a stop cannot be confirmed, secrets changed, the database is inaccessible, or the first installation has no known prior pair, retain all files and recover using the separately tested operator backup plan. Inspect `.collectiveui-deploy/last-error.log` and service logs locally; bounded command diagnostics can contain credentials, are stored privately and are deliberately omitted from public updater output.

## Admin Update button

Build this in a **separate PR** after the operator protocol and restore path are proven. A UI could display trusted available versions, request a narrowly scoped update from an operator-controlled agent and report progress. It must require admin authorization and explicit maintenance/backup acceptance. Neither web nor worker should receive broad Docker socket access, registry publishing credentials, arbitrary host command execution or generic container management permissions.
