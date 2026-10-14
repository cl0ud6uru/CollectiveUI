#!/usr/bin/env python3
"""Operator-only core Compose updater. No registry credentials or Docker socket in web."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tarfile
import time


class DeploymentError(Exception):
    pass


def read_json(path):
    if path.stat().st_size > 65536:
        raise DeploymentError("JSON document is too large")
    return json.loads(path.read_text())


def atomic_json(path, value):
    temporary = path.with_suffix(".tmp")
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600), "w") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def file_sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def validate_manifest(value, namespace):
    try:
        if not isinstance(value, dict) or type(value.get("format")) is not int:
            raise ValueError()
        revision = value["revision"]
        version = value["version"]
        if value["format"] != 1 or not re.fullmatch(r"[0-9a-f]{40}", revision):
            raise ValueError()
        if version != "sha-" + revision and not re.fullmatch(r"v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", version):
            raise ValueError()
        if not re.fullmatch(r"[0-9a-f]{64}", value["migrations_sha256"]):
            raise ValueError()
        if set(value["images"]) != {"web", "worker"}:
            raise ValueError()
        for service, reference in value["images"].items():
            pattern = re.escape(f"docker.io/{namespace}/collectiveui-{service}@sha256:") + r"[0-9a-f]{64}"
            if not re.fullmatch(pattern, reference):
                raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise DeploymentError("Invalid release manifest: expected format 1, paired Docker Hub digests, revision and migration fingerprint") from None
    return value


def verify_archive(path):
    # Storage has regular files/directories. Refuse unsafe names/links before any extraction.
    with tarfile.open(path, "r|gz") as archive:
        count = 0
        for member in archive:
            count += 1
            if member.name.startswith("/") or ".." in Path(member.name).parts or not (member.isfile() or member.isdir()):
                raise DeploymentError("Uploads backup contains an unsafe entry")
        if not count:
            raise DeploymentError("Empty uploads archive")


class Operator:
    def __init__(self, directory, project, namespace, timeout=180):
        self.directory = Path(directory).resolve()
        self.project = project
        self.namespace = namespace
        self.timeout = timeout
        self.state = self.directory / ".collectiveui-deploy"
        self.journal_path = self.state / "pending.json"
        self.current_path = self.state / "current.json"
        self.compose_file = self.directory / "docker-compose.release.yml"
        self.env_file = self.directory / ".env"
        self.identity_path = self.state / "installation.json"
        self.identity = None
        self.operation = None

    def command(self, arguments, *, manifest=None, output=None, input_file=None, timeout=600):
        # Compose interpolation must come exclusively from the recorded .env, not shell exports.
        infrastructure = {"PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY",
                          "DOCKER_CERT_PATH", "DOCKER_CONFIG", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
                          "http_proxy", "https_proxy", "no_proxy"}
        environment = {key: value for key, value in os.environ.items() if key in infrastructure}
        if manifest:
            environment.update({f"COLLECTIVEUI_{name.upper()}_IMAGE": ref for name, ref in manifest["images"].items()})
        try:
            result = subprocess.run(arguments, cwd=self.directory, env=environment,
                                    stdin=input_file, stdout=output or subprocess.PIPE,
                                    stderr=subprocess.PIPE, timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise DeploymentError("Docker command unavailable or timed out; inspect the host locally") from None
        if result.returncode:
            # One-off migration containers are removed. Retain bounded diagnostics privately for operators.
            # They may contain secrets; never include them in public output or image build contexts.
            diagnostic = self.state / "last-error.log"
            if self.state.is_dir() and not self.state.is_symlink():
                try:
                    with os.fdopen(os.open(diagnostic, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600), "wb") as stream:
                        stream.write(result.stderr[-65536:])
                        if output is None:
                            stream.write(b"\n" + result.stdout[-65536:])
                except OSError:
                    pass
            raise DeploymentError("Docker command failed; inspect the private .collectiveui-deploy/last-error.log locally without sharing secrets")
        return result.stdout.decode() if output is None else ""

    def compose(self, manifest, *args, **kwargs):
        return self.command(["docker", "compose", "--project-directory", str(self.directory),
                             "--env-file", str(self.env_file), "-p", self.project,
                             "-f", str(self.compose_file), *args], manifest=manifest, **kwargs)

    @contextlib.contextmanager
    def locked(self):
        if self.state.is_symlink():
            raise DeploymentError("State directory must not be a symlink")
        self.state.mkdir(mode=0o700, exist_ok=True)
        if self.state.stat().st_uid != os.getuid() or self.state.stat().st_mode & 0o077:
            raise DeploymentError("State directory must be owned by this operator with mode 700")
        lock_path = self.state / "lock"
        descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise DeploymentError("Another deployment operation holds the installation lock") from None
            yield
        finally:
            os.close(descriptor)

    def preflight(self, manifest):
        for path in (self.env_file, self.compose_file):
            if not path.is_file() or path.is_symlink():
                raise DeploymentError("Provide regular .env and docker-compose.release.yml files in the installation directory")
        if self.env_file.stat().st_mode & 0o077:
            raise DeploymentError("Protect runtime secrets with chmod 600 .env")
        self.command(["docker", "compose", "version"])
        daemon = self.command(["docker", "info", "--format", "{{.ID}}"] ).strip()
        if not daemon:
            raise DeploymentError("Docker daemon identity is unavailable")
        self.identity = {"project": self.project, "namespace": self.namespace, "daemon": daemon,
                         "directory": str(self.directory),
                         "compose_sha256": hashlib.sha256(self.compose_file.read_bytes()).hexdigest(),
                         "env_sha256": hashlib.sha256(self.env_file.read_bytes()).hexdigest()}
        if self.identity_path.exists() and read_json(self.identity_path) != self.identity:
            raise DeploymentError("Installation project, namespace, Docker daemon, Compose file or runtime .env changed; reconcile configuration separately before an update")
        config = json.loads(self.compose(manifest, "--profile", "maintenance", "config", "--format", "json"))
        if set(config["services"]) != {"db", "web", "worker", "migrate", "backup"}:
            raise DeploymentError("Updater supports only the stock core release services")
        for name, service in config["services"].items():
            if service.get("build") or service.get("privileged") or service.get("container_name"):
                raise DeploymentError("Custom builds, privilege or container names are unsupported")
            if service.get("entrypoint") or service.get("network_mode") or service.get("devices") or service.get("cap_add"):
                raise DeploymentError("Custom entrypoints, networks, devices or capabilities are unsupported")
            mounts = service.get("volumes", [])
            expected_targets = {"/var/lib/postgresql/data"} if name == "db" else ({"/data/uploads"} if name == "backup" else {"/data/uploads", "/etc/portal/certs"})
            if {mount["target"] for mount in mounts} != expected_targets or len(mounts) != len(expected_targets):
                raise DeploymentError("Every stock persistent/certificate mount is required")
            for mount in mounts:
                if name == "db":
                    valid = mount["type"] == "volume" and mount["source"] == "pgdata" and mount["target"] == "/var/lib/postgresql/data"
                else:
                    valid = (mount["type"] == "volume" and mount["source"] == "uploads" and mount["target"] == "/data/uploads") or (
                        mount["type"] == "bind" and Path(mount["source"]) == self.directory / "certs" and mount["target"] == "/etc/portal/certs" and mount.get("read_only"))
                if not valid:
                    raise DeploymentError("Custom storage or host mounts are unsupported; preserve and reconcile them manually")
        fixed_commands = {"worker": ["node", "--import", "tsx", "src/worker/index.ts"],
                          "migrate": ["node", "--import", "tsx", "src/db/migrate.ts"],
                          "backup": ["tar", "-C", "/data/uploads", "-czf", "-", "."]}
        for name, command in fixed_commands.items():
            if config["services"][name].get("command") != command:
                raise DeploymentError("Maintenance/runtime commands must match the stock release contract")
        if config["services"]["db"]["image"] != "pgvector/pgvector:pg16@sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a":
            raise DeploymentError("Database major version/image is outside this updater's contract")
        for name in ("pgdata", "uploads"):
            if config["volumes"][name].get("name") != f"{self.project}_{name}" or config["volumes"][name].get("external"):
                raise DeploymentError("Persistent volume identity does not match the explicit Compose project")
        for name in ("web", "worker", "migrate", "backup"):
            expected = manifest["images"]["web" if name == "web" else "worker"]
            if config["services"][name]["image"] != expected:
                raise DeploymentError("Compose image does not match the release manifest")

    def image_ids(self, manifest, pull=True):
        images = {}
        for name, reference in manifest["images"].items():
            if pull:
                self.command(["docker", "pull", "--platform", "linux/amd64", reference])
            item = json.loads(self.command(["docker", "image", "inspect", reference]))[0]
            labels = item["Config"].get("Labels") or {}
            if item["Architecture"] != "amd64" or item["Os"] != "linux" or labels.get("org.opencontainers.image.revision") != manifest["revision"] or labels.get("io.collectiveui.migrations-sha256") != manifest["migrations_sha256"]:
                raise DeploymentError("Image platform/revision/migrations do not match the manifest")
            images[name] = item["Id"]
        return images

    def helper(self, manifest, service, *args, **kwargs):
        if not self.operation:
            raise DeploymentError("Maintenance helper requires a journaled operation")
        return self.compose(manifest, "--profile", "maintenance", "run", "--rm", "--no-deps", "-T",
                            "--label", f"io.collectiveui.deploy-project={self.project}",
                            "--label", f"io.collectiveui.operation={self.operation}", service, *args, **kwargs)

    def stop_helpers(self):
        # A Docker CLI timeout/signal does not imply that its one-off container stopped.
        ids = self.command(["docker", "ps", "--all", "--quiet", "--filter",
                            f"label=io.collectiveui.deploy-project={self.project}"]).split()
        for identifier in ids:
            def inspect_if_present():
                if not self.command(["docker", "ps", "--all", "--quiet", "--filter", f"id={identifier}"]).split():
                    return None
                try:
                    return json.loads(self.command(["docker", "inspect", identifier]))[0]
                except DeploymentError:
                    # --rm may complete between listing and inspection; prove absence via the daemon.
                    if not self.command(["docker", "ps", "--all", "--quiet", "--filter", f"id={identifier}"]).split():
                        return None
                    raise
            item = inspect_if_present()
            if item is None:
                continue
            labels = item["Config"].get("Labels") or {}
            if labels.get("com.docker.compose.project") != self.project:
                raise DeploymentError("Maintenance helper ownership mismatch; manual recovery required")
            if item["State"]["Running"]:
                try:
                    self.command(["docker", "stop", "--time", "30", identifier], timeout=90)
                except DeploymentError:
                    stopped = inspect_if_present()
                    if stopped is not None and stopped["State"]["Running"]:
                        raise
            item = inspect_if_present()
            if item is None:
                continue
            if item["State"]["Running"]:
                raise DeploymentError("Maintenance helper still running; restore blocked")
            # Removing containers cannot restart or write. VFS cleanup can keep them listed for seconds.
            if item["State"].get("Status") == "removing":
                continue
            try:
                self.command(["docker", "rm", identifier])
            except DeploymentError:
                item = inspect_if_present()
                if item is not None and (item["State"]["Running"] or item["State"].get("Status") != "removing"):
                    raise

    def fence(self, manifest):
        errors = []
        for operation in (lambda: self.stop(manifest), self.stop_helpers):
            try:
                operation()
            except DeploymentError as error:
                errors.append(error)
        if errors:
            print("Could not confirm all application/helper stops. Isolate ingress and inspect Docker locally immediately.", file=sys.stderr)

    def verify_database(self, manifest):
        database = self.containers(manifest, "db")
        if len(database) != 1 or not database[0]["State"]["Running"] or not any(m.get("Name") == f"{self.project}_pgdata" and m["Destination"] == "/var/lib/postgresql/data" for m in database[0]["Mounts"]):
            raise DeploymentError("Database volume does not match the explicit project")

    def clear_pending(self):
        self.journal_path.unlink()
        descriptor = os.open(self.state, os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def containers(self, manifest, service):
        ids = self.compose(manifest, "ps", "--all", "--quiet", service).split()
        if len(ids) > 1:
            raise DeploymentError("Scaled services are outside this updater's scope")
        return [json.loads(self.command(["docker", "inspect", identifier]))[0] for identifier in ids]

    def verify_running(self, manifest, images):
        for service in ("worker", "web"):
            items = self.containers(manifest, service)
            if len(items) != 1 or items[0]["Image"] != images[service] or not items[0]["State"]["Running"] or items[0]["State"].get("Health", {}).get("Status") != "healthy":
                raise DeploymentError("Paired image identity or application readiness failed")
            mounts = items[0]["Mounts"]
            if not any(m.get("Name") == f"{self.project}_uploads" and m["Destination"] == "/data/uploads" for m in mounts):
                raise DeploymentError("Running service uploads volume does not match the installation")

    def stop(self, manifest):
        self.compose(manifest, "stop", "web", "worker", timeout=120)
        for service in ("web", "worker"):
            if any(item["State"]["Running"] for item in self.containers(manifest, service)):
                raise DeploymentError("Application did not stop; migration/restore is blocked")

    def start(self, manifest, images):
        for service in ("worker", "web"):
            self.compose(manifest, "up", "-d", "--no-build", "--pull", "never", "--no-deps", "--wait", "--wait-timeout", str(self.timeout), service, timeout=self.timeout + 60)
        self.verify_running(manifest, images)

    def set_phase(self, journal, phase):
        journal["phase"] = phase
        atomic_json(self.journal_path, journal)

    def backup(self, manifest, destination):
        destination.mkdir(mode=0o700)
        dump = destination / "database.dump"
        with dump.open("wb") as output:
            self.compose(manifest, "exec", "-T", "db", "pg_dump", "-U", "portal", "-d", "portal", "--format=custom", "--no-owner", "--no-acl", output=output)
            output.flush()
            os.fsync(output.fileno())
        if dump.stat().st_size == 0:
            raise DeploymentError("Database backup is empty")
        with dump.open("rb") as source:
            self.compose(manifest, "exec", "-T", "db", "pg_restore", "--list", input_file=source)
        uploads = destination / "uploads.tar.gz"
        with uploads.open("wb") as output:
            self.helper(manifest, "backup", output=output)
            output.flush()
            os.fsync(output.fileno())
        verify_archive(uploads)
        return {"database.dump": file_sha256(dump),
                "uploads.tar.gz": file_sha256(uploads)}

    def apply(self, manifest):
        if self.journal_path.exists():
            raise DeploymentError("Unfinished deployment exists: inspect status and recover explicitly before another update")
        self.preflight(manifest)
        previous = validate_manifest(read_json(self.current_path), self.namespace) if self.current_path.exists() else None
        if previous:
            self.verify_running(previous, self.image_ids(previous, pull=False))
        elif any(self.containers(manifest, service) for service in ("web", "worker")):
            raise DeploymentError("Existing application has no recorded release; follow the documented manual transition and adopt it")
        self.stop_helpers()
        images = self.image_ids(manifest)
        self.operation = str(time.time_ns())
        destination = self.state / ("backup-" + str(time.time_ns()))
        journal = {"phase": "prepared", "operation": self.operation, "target": manifest, "previous": previous, "backup": str(destination),
                   "env_sha256": hashlib.sha256(self.env_file.read_bytes()).hexdigest(), "image_ids": images}
        atomic_json(self.identity_path, self.identity)
        self.set_phase(journal, "prepared")
        try:
            self.stop(manifest)
            self.compose(manifest, "up", "-d", "--no-build", "--no-recreate", "--wait", "--wait-timeout", str(self.timeout), "db", timeout=self.timeout + 60)
            self.verify_database(manifest)
            self.set_phase(journal, "backing-up")
            journal["checksums"] = self.backup(manifest, destination)
            self.set_phase(journal, "backed-up")
            self.set_phase(journal, "migration-started")
            self.helper(manifest, "migrate")
            self.set_phase(journal, "starting")
            self.start(manifest, images)
            self.set_phase(journal, "ready")
            atomic_json(self.current_path, manifest)
            atomic_json(destination / "receipt.json", journal)
            self.clear_pending()
        except BaseException:
            # Never restart old code after migrations/runtime writes, including interrupts.
            self.fence(manifest)
            raise
        print(f"Healthy paired release {manifest['version']}; backup retained at {destination}")

    def adopt(self, manifest):
        if self.journal_path.exists() or self.current_path.exists():
            raise DeploymentError("Adoption requires an untracked installation with no pending operation")
        self.preflight(manifest)
        self.verify_running(manifest, self.image_ids(manifest))
        atomic_json(self.identity_path, self.identity)
        atomic_json(self.current_path, manifest)
        print("Recorded the healthy running release; no services or data changed")

    def recover(self):
        if not self.journal_path.exists():
            raise DeploymentError("No pending deployment")
        journal = read_json(self.journal_path)
        if journal["phase"] not in {"prepared", "backing-up", "backed-up"} or not journal.get("previous"):
            raise DeploymentError("Migration may have started or no previous pair is known; explicit full restore is required")
        previous = validate_manifest(journal["previous"], self.namespace)
        self.preflight(previous)
        if hashlib.sha256(self.env_file.read_bytes()).hexdigest() != journal["env_sha256"]:
            raise DeploymentError("Restore the matching runtime .env before recovery")
        try:
            self.stop(previous)
            self.stop_helpers()
            self.verify_database(previous)
            self.start(previous, self.image_ids(previous))
            self.clear_pending()
        except BaseException:
            self.fence(previous)
            raise
        print("Recovered previous release before any migration; retained partial backups for inspection")

    def rollback(self, restore_data):
        if not restore_data:
            raise DeploymentError("Rollback restores database AND uploads, losing writes since the snapshot; pass --restore-data deliberately")
        if not self.journal_path.exists():
            raise DeploymentError("No pending operation; choose a retained backup with rollback --backup PATH --restore-data")
        journal = read_json(self.journal_path)
        self.operation = journal.get("operation")
        previous = journal.get("previous")
        if not previous or not journal.get("checksums"):
            raise DeploymentError("No complete backup and previous digest pair; recover manually using retained operator backups")
        previous = validate_manifest(previous, self.namespace)
        self.preflight(previous)
        if hashlib.sha256(self.env_file.read_bytes()).hexdigest() != journal["env_sha256"]:
            raise DeploymentError("Runtime .env changed; restore the matching secrets/configuration securely before rollback")
        destination = Path(journal["backup"])
        if destination.parent != self.state or destination.is_symlink():
            raise DeploymentError("Backup must belong to this installation's protected state directory")
        if set(journal["checksums"]) != {"database.dump", "uploads.tar.gz"}:
            raise DeploymentError("Incomplete backup checksums; manual recovery required")
        for name, checksum in journal["checksums"].items():
            archive = destination / name
            if archive.is_symlink() or not archive.is_file() or file_sha256(archive) != checksum:
                raise DeploymentError("Backup checksum mismatch; manual recovery required")
        verify_archive(destination / "uploads.tar.gz")
        images = self.image_ids(previous)
        self.set_phase(journal, "restoring")
        try:
            self.stop(previous)
            self.stop_helpers()
            self.verify_database(previous)
            # --clean alone leaves new objects absent from the old dump. Recreate the fixed core DB instead.
            self.compose(previous, "exec", "-T", "db", "dropdb", "--force", "--if-exists", "-U", "portal", "portal")
            self.compose(previous, "exec", "-T", "db", "createdb", "-U", "portal", "--owner=portal", "portal")
            with (destination / "database.dump").open("rb") as source:
                self.compose(previous, "exec", "-T", "db", "pg_restore", "--single-transaction", "--exit-on-error", "--no-owner", "--no-acl", "-U", "portal", "-d", "portal", input_file=source)
            # Fixed code, no user arguments. Only the named uploads volume is mounted.
            with (destination / "uploads.tar.gz").open("rb") as source:
                self.helper(previous, "backup", "sh", "-c", "find /data/uploads -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar -C /data/uploads -xzf -", input_file=source)
            self.start(previous, images)
            atomic_json(self.current_path, previous)
            self.set_phase(journal, "restored")
            atomic_json(destination / "restore-receipt.json", journal)
            self.clear_pending()
        except BaseException:
            self.fence(previous)
            raise
        print("Restored matching database, uploads and previous paired release; retain backup for review")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True, help="Installation directory containing stock docker-compose.release.yml, .env and certs")
    parser.add_argument("--project", required=True, help="EXISTING Compose project name; determines persistent volume names")
    parser.add_argument("--namespace", required=True, help="Confirmed Docker Hub namespace (never inferred from GitHub)")
    parser.add_argument("--timeout", type=int, default=180)
    commands = parser.add_subparsers(dest="action", required=True)
    for action in ("apply", "adopt"):
        commands.add_parser(action).add_argument("manifest", type=Path)
    rollback = commands.add_parser("rollback")
    rollback.add_argument("--restore-data", action="store_true")
    rollback.add_argument("--backup", type=Path, help="Retained backup directory for rolling back a successful update")
    commands.add_parser("status")
    commands.add_parser("recover")
    arguments = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}", arguments.project) or not re.fullmatch(r"[a-z0-9]+(?:[._-][a-z0-9]+)*", arguments.namespace) or not 30 <= arguments.timeout <= 1800:
        parser.error("Invalid project, namespace or readiness timeout (30–1800 seconds)")
    os.umask(0o077)
    operator = Operator(arguments.directory, arguments.project, arguments.namespace, arguments.timeout)
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt("Operator interrupted the deployment")
    signal.signal(signal.SIGTERM, interrupted)
    try:
        with operator.locked():
            if arguments.action in ("apply", "adopt"):
                getattr(operator, arguments.action)(validate_manifest(read_json(arguments.manifest), arguments.namespace))
            elif arguments.action == "recover":
                operator.recover()
            elif arguments.action == "rollback":
                if arguments.backup:
                    if not arguments.restore_data:
                        raise DeploymentError("Choose --restore-data deliberately before preparing rollback")
                    if operator.journal_path.exists():
                        raise DeploymentError("Pending operation exists; recover that operation before selecting another backup")
                    destination = arguments.backup.resolve()
                    if destination.parent != operator.state or destination.is_symlink():
                        raise DeploymentError("Select a retained backup inside this installation's protected state directory")
                    receipt = read_json(destination / "receipt.json")
                    if read_json(operator.current_path) != receipt["target"]:
                        raise DeploymentError("Backup target is not the current release; rollback one recorded update at a time")
                    atomic_json(operator.journal_path, receipt)
                operator.rollback(arguments.restore_data)
            else:
                for name, path in (("current", operator.current_path), ("pending", operator.journal_path)):
                    if path.exists():
                        value = read_json(path)
                        print(name + ": " + (value.get("version") or value.get("phase", "unknown")))
                        if name == "pending":
                            print("backup: " + value["backup"])
                    else:
                        print(name + ": none")
    except (DeploymentError, OSError, ValueError, KeyError, tarfile.TarError, KeyboardInterrupt) as error:
        print(f"Deployment stopped: {error}. Retain backups and inspect status before recovery.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
