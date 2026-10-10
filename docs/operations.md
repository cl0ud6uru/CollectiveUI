# Operating CollectiveUI

[Back to the overview](../README.md) · [Connections](connections.md) · [Local setup](getting-started.md)

This pre-release serves one installation/organization. Validate integrations and your complete deployment before relying on it. Never use the development database seed or demo passwords in production.

## Production deployment

For a fresh local-account installation, follow [the complete bootstrap walkthrough](#standalone-vps-with-local-accounts). For directory sign-in, configure [Entra or LDAP](#active-directory-setup) and administrator access first. In either case, fill in `.env`, configure HTTPS and private network access, then build and migrate before serving traffic:

```bash
cp .env.example .env    # edit secrets, POSTGRES_PASSWORD, AUTH_URL and sign-in settings
chmod 600 .env
docker compose build
docker compose up -d db
docker compose run --rm worker npm run db:migrate
# Local-only installations: run the interactive bootstrap below before starting web.
docker compose up -d web worker
```

- The **web** service is the Next.js standalone server on port 3000. Put it behind your reverse proxy or load balancer with TLS, and set `AUTH_URL` to the public URL. Replies stream as server-sent events: turn response buffering off for `/api/chat` (nginx honours the `X-Accel-Buffering: no` the app sends; configure the equivalent streaming behavior in your proxy) and allow idle reads of at least 30 s (the app sends a keepalive every 15 s). HTTP/2 is recommended, because each open reply holds a connection. The web service can run as several instances.
- The **worker** service applies database migrations on start, then runs **every chat reply**, routines and memory extraction, so chat doesn't work without it. `AGENT_RUN_CONCURRENCY` (default 16) caps the replies one worker runs at once, `ROUTINE_RUN_CONCURRENCY` (default 2) the routines it runs next to them (they have a queue of their own, so they never hold up chat), and `RUNS_PER_USER` (default 3) the replies one person can have running; a reply waits while every slot is busy and only fails with "The background worker didn't pick up this reply" when no worker is running at all; see `.env.example` for the other `RUN_*` settings. On `docker compose stop` it has `stop_grace_period` to end its replies cleanly (they're saved and marked interrupted); replies of a worker that dies are marked interrupted by another one within about 90 s.
- Uploaded files are stored on the `uploads` volume. The storage layer (`src/lib/files/storage.ts`) is designed so Azure Blob or S3 can replace it later.
- Postgres needs the `vector` extension; the `pgvector/pgvector:pg16` image includes it. On a managed database, enable pgvector.

**Upgrading a custom storage setup:** Compose now pins `STORAGE_DIR` to `/data/uploads`; a different value in `.env` alone no longer applies. Before recreating containers, back up the database and uploaded files. To keep your current location, explicitly set `environment.STORAGE_DIR` to the same container path in a Compose override for **both `web` and `worker`**, with the existing storage mounted at that path in both services. Alternatively, stop both services and copy the existing files into the `uploads` volume, preserving their relative paths, or remount the existing storage at `/data/uploads` in both services. Ensure the container's `app` user can read and write that storage. Files are **not migrated automatically**. Check the merged `docker compose config` with your override files before starting, and verify existing logos and attachments after restarting; retain the original files and backups until verified.

## Updates, migrations and backups

1. Back up Postgres and the uploads storage, and keep the encryption keys and session secrets in a separate secure backup. Record the current application revision and Compose overrides. Test restoring to an isolated installation; a database backup alone does not include attachments or branding logos stored on disk. Private pet imports and catalog sprite bytes are in Postgres and are included in its backup.
2. Read the release's migration notes, especially [service-bot enforcement](service-bots.md#migration-and-review-behavior) and [pet inheritance](features/bot-companions.md#storage-and-access). Pull the intended revision and build it. Schedule a maintenance window and stop **both web and worker** before applying migrations so old executors cannot run against new policy.
3. On Compose, run `docker compose run --rm worker npm run db:migrate` against the existing database, then start both services with the new images. On a native installation, load the intended environment explicitly, for example `node --env-file=.env --import tsx src/db/migrate.ts`. Use the normal migration runner; do not reset the schema or edit its journal. Current main includes migrations through **0018_default_coordinator**. That migration leaves the coordinator off and existing specialists opted out; see the [coordinator upgrade contract](features/default-coordinator.md#schema-upgrade-and-async-integration-contract).
4. Check health, sign-in, a direct chat with the worker, existing attachments and logos, bot access and avatar inheritance. Migration 0017 preserves private pet bytes and credits and never publishes them; ambiguous legacy Off preferences become Follow, so tell affected users they can select **Off · original icon** again.
5. Retain the original backups and storage until verified. Never use `docker compose down -v` as an upgrade step. Coordinate rollback with the schema and policy changes; an older worker does not understand service-bot restrictions and must not execute service bots. Restore a consistent database/files/application set if needed.

When rotating encryption keys, retain the old key while adding a new primary key; see [encryption and runtime architecture](development.md#architecture). Losing the key makes encrypted credentials unreadable. Do not revoke the old key before all stored secrets are rewrapped and backups have a recovery plan.

## Standalone VPS with local accounts

This is one installation/organization, not a multi-tenant SaaS boundary. Local and directory accounts with the same email remain **different users** with different private chats, files, tokens and permissions. Local accounts do not inherit `ADMIN_UPNS`, `ADMIN_GROUPS`, directory memberships or Microsoft 365 tokens. Their policy identifier is `local:<username>`; local users can use public apps/org bots, while directory group restrictions remain in force. Admins can manage the installation. There is no self-registration, email verification/linking, default local password, or authentication bypass.

1. Copy `.env.example` to `.env` and restrict it to the operator (`chmod 600 .env`). Set `AUTH_LOCAL_ENABLED=true`, `AUTH_ENTRA_ENABLED=false`, `LDAP_ENABLED=false`, `AUTH_URL=https://your-host.example`, and `WEB_BIND=127.0.0.1` (Compose sets `STORAGE_DIR=/data/uploads` itself). Set a strong, unique `POSTGRES_PASSWORD` (URL-encode reserved characters in a native `DATABASE_URL`) and independently generate `AUTH_SECRET`, `ENCRYPTION_KEY`, and `TOOL_APPROVAL_SECRET` as documented in `.env.example`. Do not reuse the development fixture passwords or seed a production database with `db:seed`.
2. Put a TLS reverse proxy in front of the web service. Forward the public Host/protocol, limit request sizes and authentication request rates, and prevent direct access to the app port. Keep Postgres private. `AUTH_URL` is the canonical public origin and is required for account mutations. Do not enable Auth.js debug/body logging at the proxy or application.
3. Build the images and start the database, then migrate before starting web/worker:

   ```bash
   docker compose build
   docker compose up -d db
   docker compose run --rm worker npm run db:migrate
   docker compose run --rm -e LOCAL_AUTH_OPERATOR=bootstrap worker npm run local-account -- bootstrap
   docker compose up -d web worker
   ```

   The bootstrap command requires an interactive TTY and prompts for username, display name, optional email, and a hidden password with confirmation. It creates exactly one initial administrator under a database transaction lock. It refuses if local credentials already exist or the persistent bootstrap marker has been used. Merely enabling local auth or visiting the site creates nothing. Never persist `LOCAL_AUTH_OPERATOR` in `.env`; it is a per-command acknowledgement. No passwords are accepted via CLI arguments or environment variables. With a native Node installation, load the environment explicitly, for example `LOCAL_AUTH_OPERATOR=bootstrap node --env-file=.env --import tsx scripts/local-account.ts bootstrap`.
4. Sign in and use **Admin → Users → Create local account**. Pick a temporary password and deliver it through a private channel after checking the recipient's identity. Temporary passwords expire after 24 hours. Their sessions can only change the password, not view chats or administer the portal. The user must choose a different permanent password and sign in again. Create a second local administrator and have them complete first sign-in before changing the first administrator's access.
5. Keep the `pgdata` and `uploads` volumes, plus encryption/session secrets, across restarts and upgrades. Back up and restore them together; do not use `docker compose down -v` as an upgrade step. Password hashes, local aliases, revocation versions, throttle counters and the bootstrap marker all live in Postgres, not the container filesystem. Share database/storage and auth secrets across replicas. The worker is still required for chat replies and home-chat behavior.

### Provider switches, sessions and upgrades

`AUTH_LOCAL_ENABLED=true` explicitly enables local accounts. `AUTH_ENTRA_ENABLED=false` disables Microsoft login (otherwise a configured client ID enables it); `LDAP_ENABLED=true` plus `LDAP_URL` enables LDAP. The same switches govern UI, credential authorization and existing sessions. Restart all web replicas after changing them. Disabling local login does not delete accounts or hashes. Re-enabling a provider can allow unexpired sessions unless revoked; use **Revoke sessions**, or rotate `AUTH_SECRET` to invalidate every session when decommissioning a provider.

Apply **0011_local_accounts**, after **0010_bot_home**, before running the new web/worker code. It adds the local credential/alias/bootstrap/throttle tables and user identity realm/session version. Existing users default to the directory realm and retain IDs, memberships and data; Entra/LDAP continue their existing hybrid-UPN behavior. No existing user is given a password or local role. Back up first and deploy application and schema together; old binaries expect the old UPN uniqueness constraint.

Passwords use Node/OpenSSL **scrypt (N=131072, r=8, p=1)** with a fresh random salt, a constant-time comparison, and bounded concurrent hashing (two hashes per web process, about 256 MiB total KDF memory). This follows [OWASP's scrypt guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). Permanent and temporary passwords require 15–128 Unicode characters, at most 512 UTF-8 bytes, with common trivial patterns rejected; spaces and password-manager paste work, and passwords are not trimmed or silently truncated. Use unique generated passphrases. Local accounts support optional passkeys and TOTP; LDAP accounts support optional CollectiveUI passkeys. See [account security](security/local-mfa.md).

Password attempts are limited atomically in Postgres: 120 per minute installation-wide, 30 per 15 minutes per source, 10 per 15 minutes per local account (username/email share a bucket), including successful attempts. LDAP receives the same global/source limits and an identifier limit. Unknown, disabled, expired, throttled and incorrect local logins return the same error. Counters survive restarts and expire automatically; no permanent lockout. By default sources share one bucket, safely ignoring spoofable forwarding headers. Set `AUTH_TRUST_PROXY=true` only behind a trusted reverse proxy that **overwrites X-Real-IP**, strips client-supplied forwarding headers and blocks direct access to web. Internet-facing deployments should also rate-limit at the proxy to protect bandwidth/process capacity; the built-in limits deliberately favor a small standalone installation.

Auth.js retains its encrypted HttpOnly, SameSite cookies, HTTPS Secure cookies and CSRF checks. Sensitive local account server actions additionally require Origin to match `AUTH_URL` exactly, including when a request omits Origin. New sessions have a 12-hour absolute lifetime. Disable, reset, password change, role change and **Revoke sessions** increment a server-side version checked on subsequent authenticated requests; re-enabling an account never restores the revoked sessions. Already authorized/in-flight responses cannot be recalled. Existing directory sessions survive migration until expiration unless their account is revoked. Hashes and temporary passwords never appear in user listings or audit records; the audit records account lifecycle actions without secrets.

### Password reset and operator recovery

Users change their own password under **Settings → Change local password**, supplying the current password. Admins use **Admin → Users → Reset local password** for other local users after independently verifying identity. This revokes their sessions immediately and issues an admin-chosen temporary password valid for 24 hours; deliver it privately and have the recipient replace it on next sign-in. There is no public reset endpoint or email service. An admin cannot reset their own password through this control. Disabling is reversible; accounts are not deleted through this UI, preserving chats/audit history.

The server serializes lifecycle mutations and refuses disabling, demoting or issuing a temporary reset to the last enabled local administrator with a permanent password. This keeps a local recovery path even when directory admins exist. It cannot protect against intentional database edits or disabling every provider in the environment.

If all admin passwords are lost, use operator shell access to the **same persistent database**:

```bash
docker compose run --rm -e LOCAL_AUTH_OPERATOR=recover-admin worker npm run local-account -- recover-admin
```

Enter an **existing local administrator's** username/email and a new hidden password. This preserves their identity/data, re-enables that admin, sets a permanent password, revokes previous sessions, and writes a recovery audit event. It does not promote an ordinary user or reset a directory password. Native equivalent: `LOCAL_AUTH_OPERATOR=recover-admin node --env-file=.env --import tsx scripts/local-account.ts recover-admin`. Restore `AUTH_LOCAL_ENABLED=true` first if the operator disabled it. If the database was lost, restore the backup rather than deleting the bootstrap marker; it is not a reset switch. A stolen database backup should trigger password resets and session-secret rotation after restoring trusted service.

## Active Directory setup

### Option A: Microsoft Entra ID (recommended)

1. In Entra admin center, go to **App registrations → New registration**.
   - Redirect URI (Web): `https://<your-portal>/api/auth/callback/microsoft-entra-id`
2. Under **Certificates & secrets**, create a client secret. Set `AUTH_MICROSOFT_ENTRA_ID_ID` (the Application/client ID), `AUTH_MICROSOFT_ENTRA_ID_SECRET`, and `AUTH_MICROSOFT_ENTRA_ID_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0`.
3. Under **Token configuration → Add groups claim**, choose **Groups assigned to the application** (recommended) or Security groups. Then, under **Enterprise applications → your app → Users and groups**, assign the AD groups that should have access. This keeps tokens under the 200-group limit. If a token still overflows, the portal falls back to Microsoft Graph `transitiveMemberOf`, which needs `GroupMember.Read.All`.
4. Optional: to use the Microsoft 365 bot connector, add the delegated Graph permissions (`Mail.Read`, `Mail.Send`, `Calendars.Read`, `Sites.Read.All`, `Files.Read.All`), grant admin consent, and set `ENTRA_GRAPH_SCOPES` to match.
5. In **Admin → Groups**, map portal groups to the Entra **group object IDs**.

### Option B: On-prem AD over LDAPS

- Create a read-only service account. Set `LDAP_URL=ldaps://dc:636`, `LDAP_BIND_DN`, `LDAP_BIND_PASSWORD` and `LDAP_BASE_DN`. Point `LDAP_CA_CERT` at your internal root CA certificate. With Compose, put the PEM file in `./certs` (mounted at `/etc/portal/certs`) and use the in-container path; [certs/README.md](../certs/README.md) shows how to export the root CA from AD.
- If the directory can't be reached (connection, TLS, CA file or service-account bind failure), sign-in says so instead of reporting a wrong password, and the web log records the cause as `[auth] LDAP directory unavailable (...)`.
- Users can sign in as `jdoe`, `DOMAIN\jdoe` or `jdoe@corp.com`. Nested groups are resolved with `LDAP_GROUP_MODE=ad`, which uses the `1.2.840.113556.1.4.1941` in-chain match.
- Search filters are escaped against LDAP injection, and empty passwords (which some servers treat as anonymous binds) are rejected.
- For passwordless company sign-in, apply migration **0034_ldap_passkeys** and enroll a passkey in Settings → Security. The read-only service account must read `objectGUID`, `userAccountControl`, `msDS-User-Account-Control-Computed`, `accountExpires`, identity and group attributes. Password-only LDAP login is blocked after enrollment; fallback requires company password plus a recovery code. See [directory checks and recovery](security/local-mfa.md#ldap-passkeys-2026-10-06).
- Map portal groups to group **DNs**. They are compared in lower case, and the admin UI suggests DNs it has already seen at sign-in.
- In **Admin → Groups**, select **Individual users** to add existing portal accounts directly. Direct membership survives directory synchronization and grants the same connection, bot-creation and admin permissions as mapped directory membership. Removing a direct member does not remove membership inherited through a directory group.
- In the bot editor, **Who can use it → Specific groups or users** supports groups, individual accounts, or both. These grants permit bot use, not bot editing or extra connector access. Service bots must be published again after their audience changes.
- Apply migration **0035_direct_user_permissions** before starting the updated web/worker; existing group mappings and bot audiences are preserved.

You can enable both options at once. Hybrid users are matched by UPN, so either sign-in method reaches the same account. Set `AUTH_ENTRA_ENABLED=false` or `LDAP_ENABLED=false` to turn one off.

**Bootstrap admins:** set `ADMIN_UPNS` and/or `ADMIN_GROUPS`, separated by semicolons (LDAP DNs contain commas). After that, grant admin rights through groups or on the Users page.

## Workspaces (sandboxed commands)

A workspace is a Docker container per person, run by **sandboxd** (`src/sandboxd/`), a small daemon that is the only process with access to the Docker socket. The web app and worker ask it for things over HTTP, signed with `SANDBOXD_SECRET`; it has no database access and no keys, and creates containers from one fixed spec:

- no network (`none`), all capabilities dropped, `no-new-privileges`, read-only root filesystem, uid 1000;
- memory (no swap), CPU, process, open-file and file-size limits; `/tmp` is a size-limited tmpfs;
- one volume mounted at `/home/agent`, which is all that persists; no host paths, devices or published ports;
- gVisor (`runsc`) as the runtime where available, so commands don't run directly against the host kernel.

Nothing secret enters a workspace: no model keys, ChatGPT sign-ins or portal tokens. Idle workspaces stop after 20 minutes and start again on next use; files stay until the person resets their workspace, or until `Keep a disabled person's files` runs out after their account is disabled.

**Host setup (once):**

**Easy setup:** open **Admin → Workspaces → Easy setup** for an operator checklist and copyable commands. **Run setup check** checks the portal's configured connection, authenticated daemon response, Docker/image readiness and the saved isolation policy. It does not install software, change settings, grant access or run a command in a person's workspace. Health checks can run sandboxd's existing temporary gVisor probe; passing prerequisites does not establish worker connectivity, storage monitoring or a successful bot command/file test.

For the stock Linux Compose add-on, run `npm run workspace:check` from the checkout on the Docker host (or `npm run workspace:check -- --env-file PATH`). This read-only preflight reports missing secrets by name without showing values, socket-group configuration, Docker availability, runsc registration, the configured image and Compose validation. It exits nonzero while prerequisites are missing and never installs, generates secrets, edits files or restarts services. For custom Compose deployments use the commands below with the actual files, env-file and project options; this helper validates only the stock files.

The supported installer path is the existing Compose add-on below. Host runtime installation, secret generation and starting/recreating services remain deliberate operator steps. The portal receives no Docker socket. Workspaces and standard isolation still default off; changing workspaces from off to on now requires an explicit audience confirmation and a fresh server readiness check. You can save selected groups/people while access is off. All admins are included in selected access; empty selections therefore mean admins only. Recheck, enable a small trusted audience, then verify approval and command/file behavior using a native bot before expanding access.

1. Install gVisor and register it with Docker. Prefer the [official apt package](https://gvisor.dev/docs/user_guide/install/); for a manual installation, extract the **entire** verified release:
   ```bash
   (
     set -e
     ARCH=$(uname -m)
     URL=https://storage.googleapis.com/gvisor/releases/release/latest/${ARCH}
     curl -fsSLO "${URL}/gvisor.tar.bz2" -fsSLO "${URL}/gvisor.tar.bz2.sha512"
     sha512sum -c gvisor.tar.bz2.sha512
     sudo tar -xjf gvisor.tar.bz2 -C /usr/local/bin
     sudo /usr/local/bin/runsc install
     sudo dockerd --validate --config-file=/etc/docker/daemon.json
     sudo systemctl reload docker
     docker info --format '{{json .Runtimes}}'
     docker run --rm --runtime=runsc hello-world
   )
   ```
   The release includes `runsc`, its shim and `gvisor-bin/` sidecars. Keep the sidecars beside `runsc`; extracting only two binaries is incomplete. If `tar` lacks bzip2 support, use the official zstd archive with matching checksum and `tar --zstd`, or install an appropriate decompressor first.

   Docker supports [runtime configuration reload](https://docs.docker.com/reference/cli/dockerd/#configuration-reload-behavior). If the systemd unit has no reload action, signal only its main daemon with `sudo systemctl kill -s HUP --kill-who=main docker.service`. Validate the actual configuration path and service flags on custom installations. Confirm `runsc` appears in the runtime list and the real container probe succeeds; a successful signal alone is insufficient. Record existing containers' `StartedAt` values before and after. If reload fails, diagnose it and arrange a maintenance window before restarting a shared Docker host.

   Keep the runtime's default flags: sandboxd won't use gVisor configured with `--overlay2=all:…` (workspace files would live in memory and be lost), and warns about network, ptrace or debug flags.
2. Build the workspace image: `scripts/build-sandbox-image.sh` (tag `ai-portal-sandbox:p5`; set `BASE_IMAGE` to use a registry mirror with the same digest).
3. Run `openssl rand -base64 32` and `stat -c '%g' /var/run/docker.sock` in your shell. Paste their outputs into `.env` as `SANDBOXD_SECRET` and `DOCKER_GID`; `.env` does not execute shell commands. Keep the secret in restricted operator files and share it only with web, worker and sandboxd.
4. Review the merged configuration before starting the add-on:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.sandbox.yml config --quiet
   # Inspect the full merged config locally; it may include secrets, so don't paste it into chat or logs.
   docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d --build
   docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec sandboxd node src/sandboxd/index.ts --check
   ```
   For custom production files, substitute their actual filenames and env-file/project options in every command. Compose [merges network mappings by name](https://docs.docker.com/reference/compose-file/merge/); the add-on does not generally replace existing network lists. Inspect the resulting web/worker networks and preserve their ingress and database connections. Only web, worker and sandboxd should join the internal `control` network. sandboxd should have no published port, app `env_file`, app secrets, database/upload mounts or public network. Docker socket access is **host-root-equivalent**, even with a non-root user, dropped capabilities and a read-only filesystem; protect the daemon and its control secret accordingly.
5. **Admin → Workspaces** (`/admin/sandboxes`): run the setup check, choose who gets access, turn workspaces on, confirm the audience and save. Selected access includes **all admins** as well as the selected users/groups. Then add the **Workspace** tools to an eligible native bot; external Hermes tools use a separate execution path. Ask the bot to run `printf 'workspace ready\n'`, approve the command, and verify its output plus a file write/read. No paid model or bot test runs as part of setup checks.

**Limits and rollout:**

Workspace volumes have no size quota (Docker's local volume driver can't enforce one portably): a workspace can fill the disk that holds Docker's data root. Keep that data on its own filesystem where practical. Monitor free bytes **and inodes**, total workspace-volume growth, and per-user usage under **Settings → Workspace**. Set an operator alert threshold before enabling users (for example, warn at 75% filesystem use and suspend new workspace work at 85%, or earlier if the free-space reserve is insufficient). These are monitoring/runbook thresholds, not automatic enforcement. Start with trusted selected users and admins; expand only after capacity, storage growth and recovery are measured. Disabling workspaces prevents new tool access; stop running workspaces separately if needed. Reset/destroy removes files and requires deliberate user/admin action; keep backups when files matter.

sandboxd refuses to start if Docker can't enforce memory, process or CPU limits (and warns if it can't limit swap). Its limits (`SANDBOXD_MEMORY_MB`, `SANDBOXD_CPUS`, `SANDBOXD_PIDS`, `SANDBOXD_MAX_RUNNING`, `SANDBOXD_MAX_EXECS`, `SANDBOXD_MAX_EXEC_SECONDS`, `SANDBOXD_IDLE_MINUTES`; see `src/sandboxd/config.ts`) are its own settings, so the portal can't raise them. Memory/CPU/PID limits and `MAX_EXECS` apply **per workspace**, not per host; budget aggregate usage for all admitted workspaces.

Run **one sandboxd process per Docker daemon**. `MAX_RUNNING` serializes workspace admission across owners through count/eviction/create/start. Counts come from Docker on every admission, including after restart or failed operations. When full, it stops enough least-recently-used idle workspaces to admit the next one, or returns capacity if commands/file helpers are active. The ceiling covers workspace containers labeled with that daemon's `SANDBOXD_INSTANCE`; probes and unrelated containers are outside it. Multiple daemon processes do not share the admission lock, and differently labeled instances have separate limits: this is not a host-wide limit across independent managers. Do not scale sandboxd replicas against one Docker socket or rely on it to constrain external Docker operators.

`node src/sandboxd/index.ts --check` runs startup checks and prints what it found. Backend file/command smoke tests do not establish that browser approval cards, delegated approvals, artifact links or model-driven chat work. Test those flows with the intended users before broad rollout; commands still require human approval.

**Updating sandboxd:**

A web/worker image update does not update a separately pinned daemon image. Whenever `src/sandboxd/` or the Dockerfile's `sandboxd` stage changes, rebuild and recreate the daemon with the actual deployment Compose files/options:

```bash
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml build sandboxd
# Wait for active workspace commands/file operations to finish before replacing the daemon.
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d --no-deps --force-recreate sandboxd
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml exec sandboxd node src/sandboxd/index.ts --check
```

For externally built images, build `docker build --target sandboxd -t <new-daemon-tag> .`, update the deployment's sandboxd image tag, then recreate it. Confirm the running container's image ID matches the new build and that authenticated health works from web/worker. Restart recovery retains workspace volumes and counts existing containers; it cannot resume an in-memory command stream. Do not delete volumes to update code. Rebuild the workspace image separately when `docker/sandbox/` changes, then verify stop/start persistence and command timeout/isolation behavior.

**Without gVisor** (e.g. Docker Desktop): set `SANDBOXD_RUNTIME=auto` (or `runc`) and, in **Admin → Workspaces**, allow standard isolation; that needs an explicit acknowledgement, recorded with your name. Containers then share the host kernel, so a kernel bug could let a command escape. If you run this way on a shared host, consider Docker's [userns-remap](https://docs.docker.com/engine/security/userns-remap/), which maps container uids to unprivileged host uids (it applies to the whole daemon, and existing images and volumes have to be recreated). Rootless Docker also works, on cgroup v2 hosts with systemd, where it can still enforce limits.

**Local development:** build the image, then run sandboxd from the repo with its own env file (it never reads `.env.local`):

```bash
npm run sandbox:image
printf 'SANDBOXD_SECRET=%s\nSANDBOXD_RUNTIME=auto\n' "$(openssl rand -base64 32)" > .env.sandboxd
npm run sandboxd:dev                                  # http://127.0.0.1:4200
# and in .env.local: SANDBOXD_URL=http://127.0.0.1:4200 plus the same SANDBOXD_SECRET
```

## Routines via webhook

Each webhook routine shows its URL and secret. Calls must be authenticated in one of two ways:

```bash
BODY='{"ticket":"INC-123"}'
SIG=$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)
curl -X POST "$PORTAL/api/routines/webhook/$ROUTINE_ID" -H "X-Portal-Signature: sha256=$SIG" -d "$BODY"
# or, for tools that can't sign requests (e.g. Power Automate): -H "Authorization: Bearer $SECRET"
```

The JSON payload is added to the bot's task for that run.
