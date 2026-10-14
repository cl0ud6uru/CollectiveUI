"""Offline tests for the operator-only release updater.

Every Docker/Compose interaction below is replaced with a deterministic fixture. These
tests never contact a registry, Docker daemon, or application service.
"""
import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "deploy-release.py"
SPEC = importlib.util.spec_from_file_location("deploy_release", SCRIPT)
deploy = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(deploy)


REVISION = "a" * 40
PREVIOUS_REVISION = "e" * 40
MIGRATIONS = "b" * 64
WEB_DIGEST = "c" * 64
WORKER_DIGEST = "d" * 64
NAMESPACE = "collectiveui"
PROJECT = "portal"
POSTGRES16_IMAGE = "pgvector/pgvector:pg16@sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a"


def manifest(revision=REVISION, version=None, migrations=MIGRATIONS, namespace=NAMESPACE,
             web_digest=WEB_DIGEST, worker_digest=WORKER_DIGEST):
    version = version or "sha-" + revision
    return {
        "format": 1,
        "revision": revision,
        "version": version,
        "migrations_sha256": migrations,
        "images": {
            "web": f"docker.io/{namespace}/collectiveui-web@sha256:{web_digest}",
            "worker": f"docker.io/{namespace}/collectiveui-worker@sha256:{worker_digest}",
        },
    }


class FixtureOperator(deploy.Operator):
    """An Operator that records calls and substitutes all Docker-facing work."""

    def __init__(self, directory, *, config=None):
        super().__init__(directory, PROJECT, NAMESPACE)
        self.calls = []
        self.config = config
        self.fail_at = None
        self.inspect = None
        self.app_started = False
        self.image_map = {"web": "sha256:web-id", "worker": "sha256:worker-id"}
        self.db_image = POSTGRES16_IMAGE
        self.db_version_result = "160000|t"
        self.db_running = True
        self.db_present = True

    def is_ancestor(self, previous_revision, target_revision):
        # Most updater-flow tests use synthetic revisions; Git ancestry has dedicated tests below.
        return True

    def command(self, arguments, *, manifest=None, output=None, input_file=None, timeout=600):
        self.calls.append(("command", tuple(arguments)))
        if arguments[:3] == ["docker", "compose", "version"]:
            return "Docker Compose version test"
        if arguments[:3] == ["docker", "info", "--format"]:
            return "fixture-daemon\n"
        if arguments[:3] == ["docker", "image", "inspect"]:
            if self.inspect is not None:
                return json.dumps([self.inspect])
            return json.dumps([{
                "Id": "sha256:fixture",
                "Architecture": "amd64",
                "Os": "linux",
                "Config": {"Labels": {
                    "org.opencontainers.image.revision": REVISION,
                    "io.collectiveui.migrations-sha256": MIGRATIONS,
                }},
            }])
        if arguments and arguments[0] == "docker" and arguments[1] == "pull":
            if self.fail_at == "pull":
                raise deploy.DeploymentError("fixture pull failure")
            return ""
        raise AssertionError(f"unexpected command in synthetic fixture: {arguments}")

    def compose(self, release, *args, **kwargs):
        self.calls.append(("compose", tuple(args)))
        if "psql" in args:
            return self.db_version_result
        if args[-1:] == ("db",) and args[:2] == ("up", "-d"):
            self.app_started = True
            self.db_running = True
        if self.fail_at == "migration" and args[-1:] == ("migrate",):
            raise deploy.DeploymentError("fixture migration failure")
        if self.fail_at == "db-up" and args[-1:] == ("db",):
            raise deploy.DeploymentError("fixture database start failure")
        if self.fail_at == "readiness" and args[:2] == ("up", "-d"):
            raise deploy.DeploymentError("fixture readiness failure")
        if "config" in args:
            return json.dumps(self.config)
        return ""

    def helper(self, release, service, *args, **kwargs):
        self.calls.append(("helper", service, tuple(args)))
        if service == "migrate" and self.fail_at == "migration":
            raise deploy.DeploymentError("fixture migration failure")
        return ""

    def stop_helpers(self):
        self.calls.append(("stop_helpers",))

    def preflight(self, release):
        self.calls.append(("preflight", release["version"]))
        self.identity = {"project": self.project, "namespace": self.namespace, "fixture": True}
        if self.fail_at == "preflight":
            raise deploy.DeploymentError("fixture preflight failure")

    def image_ids(self, release, pull=True):
        self.calls.append(("images", pull, release["version"]))
        if pull and self.fail_at == "pull":
            raise deploy.DeploymentError("fixture pull failure")
        if self.fail_at == "image-metadata":
            raise deploy.DeploymentError("Image platform/revision/migrations do not match the manifest")
        return dict(self.image_map)

    def containers(self, release, service):
        self.calls.append(("containers", service))
        if service == "db":
            if not self.db_present:
                return []
            return [{"State": {"Running": self.db_running},
                     "Config": {"Image": self.db_image},
                     "Mounts": [{"Name": f"{self.project}_pgdata", "Destination": "/var/lib/postgresql/data"}]}]
        if not self.app_started:
            return []
        return [{
            "Image": self.image_map[service],
            "State": {"Running": True, "Health": {"Status": "healthy"}},
            "Mounts": [{"Name": f"{self.project}_uploads", "Destination": "/data/uploads"}],
        }]

    def verify_running(self, release, images):
        self.calls.append(("verify-running", release["version"]))
        if self.fail_at == "adopt-mismatch":
            raise deploy.DeploymentError("Paired image identity or application readiness failed")

    def stop(self, release):
        self.calls.append(("stop", release["version"]))
        self.app_started = False

    def start(self, release, images):
        self.calls.append(("start", release["version"]))
        self.app_started = True
        if self.fail_at == "readiness":
            raise deploy.DeploymentError("fixture readiness failure")

    def backup(self, release, destination):
        self.calls.append(("backup", release["version"]))
        if self.fail_at == "backup":
            raise deploy.DeploymentError("fixture backup failure")
        destination.mkdir(mode=0o700)
        (destination / "database.dump").write_bytes(b"fixture database")
        with tarfile.open(destination / "uploads.tar.gz", "w:gz") as archive:
            info = tarfile.TarInfo("uploads.txt")
            info.size = len(b"fixture uploads")
            archive.addfile(info, io.BytesIO(b"fixture uploads"))
        return {
            "database.dump": hashlib.sha256((destination / "database.dump").read_bytes()).hexdigest(),
            "uploads.tar.gz": hashlib.sha256((destination / "uploads.tar.gz").read_bytes()).hexdigest(),
        }


class ManifestValidationTests(unittest.TestCase):
    def test_rejects_image_references_from_wrong_namespace(self):
        with self.assertRaises(deploy.DeploymentError):
            deploy.validate_manifest(manifest(namespace="someone-else"), NAMESPACE)

    def test_rejects_missing_or_malformed_digest_version_revision_and_migrations(self):
        valid = manifest()
        cases = {
            "missing web digest": {**valid, "images": {"worker": valid["images"]["worker"]}},
            "bad web digest": {**valid, "images": valid["images"] | {"web": valid["images"]["web"][:-1] + "z"}},
            "missing worker digest": {**valid, "images": {"web": valid["images"]["web"]}},
            "bad version": valid | {"version": "latest"},
            "noncanonical version": valid | {"version": "v01.2.3"},
            "short revision": valid | {"revision": "a" * 39},
            "uppercase revision": valid | {"revision": "A" * 40},
            "bad migration fingerprint": valid | {"migrations_sha256": "x" * 64},
        }
        for label, value in cases.items():
            with self.subTest(case=label), self.assertRaises(deploy.DeploymentError):
                deploy.validate_manifest(value, NAMESPACE)


class ForwardReleaseTests(unittest.TestCase):
    @staticmethod
    def _built(revision, version):
        web = hashlib.sha256((revision + "web").encode()).hexdigest()
        worker = hashlib.sha256((revision + "worker").encode()).hexdigest()
        return manifest(revision, version=version, web_digest=web, worker_digest=worker)

    def test_exact_current_manifest_is_idempotent_without_downtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            op = FixtureOperator(tmp)
            op.state.mkdir(mode=0o700)
            (op.directory / ".env").write_text("POSTGRES_PASSWORD=synthetic\n")
            current = manifest(version="v1.2.3")
            deploy.atomic_json(op.current_path, current)
            op.app_started = True
            op.apply(current)
            self.assertFalse(any(call[0] == "stop" for call in op.calls))
            self.assertFalse(any(call[0] == "images" and call[1] for call in op.calls))
            self.assertFalse(any(call[0] in {"backup", "helper"} for call in op.calls))

    def test_forward_guard_rejects_equal_or_older_versions_and_metadata_reuse(self):
        with tempfile.TemporaryDirectory() as tmp:
            op = FixtureOperator(tmp)
            current = manifest(version="v1.2.3")
            invalid = (
                self._built("f" * 40, "v1.2.3"),
                self._built("f" * 40, "v1.2.2"),
                current | {"images": current["images"] | {"web": current["images"]["web"][:-1] + "e"}},
                current | {"migrations_sha256": "f" * 64},
            )
            for candidate in invalid:
                with self.subTest(candidate=candidate), self.assertRaises(deploy.DeploymentError):
                    op.verify_forward(current, candidate)

    def test_git_ancestry_allows_descendant_and_rejects_ancestor_or_divergent_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            repo.mkdir()

            def git(*args):
                return subprocess.run(["git", "-C", str(repo), *args], check=True,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout.strip()

            git("init", "--quiet")
            git("config", "user.name", "Deployment Test")
            git("config", "user.email", "fixture@invalid.example")
            (repo / "history.txt").write_text("base\n")
            git("add", "history.txt")
            git("commit", "--quiet", "-m", "base")
            base = git("rev-parse", "HEAD")
            (repo / "history.txt").write_text("base\nforward\n")
            git("commit", "--quiet", "-am", "forward")
            child = git("rev-parse", "HEAD")
            git("checkout", "--quiet", "--detach", base)
            (repo / "history.txt").write_text("base\ndivergent\n")
            git("commit", "--quiet", "-am", "divergent")
            divergent = git("rev-parse", "HEAD")

            op = deploy.Operator(repo, PROJECT, NAMESPACE)
            op.verify_forward(self._built(base, "v1.0.0"), self._built(child, "v1.1.0"))
            with self.assertRaises(deploy.DeploymentError):
                op.verify_forward(self._built(child, "v2.0.0"), self._built(base, "v3.0.0"))
            with self.assertRaises(deploy.DeploymentError):
                op.verify_forward(self._built(child, "v2.0.0"), self._built(divergent, "v3.0.0"))

    def test_shallow_checkout_is_not_accepted_as_ancestry_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            repo.mkdir()
            def git(*args):
                return subprocess.run(["git", "-C", str(repo), *args], check=True,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout.strip()
            git("init", "--quiet")
            git("config", "user.name", "Deployment Test")
            git("config", "user.email", "fixture@invalid.example")
            (repo / "history.txt").write_text("commit\n")
            git("add", "history.txt")
            git("commit", "--quiet", "-m", "commit")
            revision = git("rev-parse", "HEAD")
            (repo / ".git" / "shallow").write_text(revision + "\n")
            op = deploy.Operator(repo, PROJECT, NAMESPACE)
            with self.assertRaisesRegex(deploy.DeploymentError, "full reviewed Git checkout"):
                op.is_ancestor(revision, revision)

    def test_apply_rejects_v2_to_v1_before_pulling_or_stopping(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".env").write_text("POSTGRES_PASSWORD=synthetic\n")
            op = FixtureOperator(root)
            op.state.mkdir(mode=0o700)
            op.app_started = True
            current = manifest(revision=PREVIOUS_REVISION, version="v2.0.0")
            deploy.atomic_json(op.current_path, current)
            with self.assertRaisesRegex(deploy.DeploymentError, "newer stable version"):
                op.apply(manifest(revision=REVISION, version="v1.0.0"))
            self.assertFalse(any(call[0] == "stop" for call in op.calls))
            self.assertFalse(any(call[0] == "images" and call[1] for call in op.calls))
            self.assertTrue(op.app_started)

    def test_recorded_release_with_missing_database_is_not_treated_as_current(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".env").write_text("POSTGRES_PASSWORD=synthetic\n")
            op = FixtureOperator(root)
            op.state.mkdir(mode=0o700)
            op.app_started = True
            op.db_present = False
            current = manifest(version="v1.2.3")
            deploy.atomic_json(op.current_path, current)
            with self.assertRaises(deploy.DeploymentError):
                op.apply(current)
            self.assertFalse(any(call[0] == "stop" for call in op.calls))
            self.assertFalse(any(call[0] == "images" and call[1] for call in op.calls))
            self.assertEqual(json.loads(op.current_path.read_text()), current)


class DatabaseIdentityTests(unittest.TestCase):
    def test_database_requires_supported_pg16_image_and_runtime_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            op = FixtureOperator(tmp)
            deploy.Operator.verify_database(op, manifest(), require_running=False)

            op.db_image = "pgvector/pgvector:pg14"
            with self.assertRaises(deploy.DeploymentError):
                deploy.Operator.verify_database(op, manifest(), require_running=False)

            op.db_image = POSTGRES16_IMAGE
            op.db_version_result = "140000|t"
            with self.assertRaises(deploy.DeploymentError):
                deploy.Operator.verify_database(op, manifest(), require_running=False)

            op.db_version_result = "160000|f"
            with self.assertRaises(deploy.DeploymentError):
                deploy.Operator.verify_database(op, manifest(), require_running=False)

    def test_stopped_pg16_is_checked_again_after_database_start(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".env").write_text("POSTGRES_PASSWORD=synthetic\n")
            op = FixtureOperator(root)
            op.state.mkdir(mode=0o700)
            op.db_running = False
            op.apply(manifest())

            db_start = next(i for i, call in enumerate(op.calls)
                            if call[0] == "compose" and call[1][:2] == ("up", "-d") and call[1][-1:] == ("db",))
            psql = [i for i, call in enumerate(op.calls)
                    if call[0] == "compose" and "psql" in call[1]]
            self.assertEqual(len(psql), 1)
            self.assertGreater(psql[0], db_start)

    def test_apply_checks_existing_database_before_any_service_stop_or_image_pull(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".env").write_text("POSTGRES_PASSWORD=synthetic\n")
            op = FixtureOperator(root)
            op.state.mkdir(mode=0o700)
            op.db_image = "pgvector/pgvector:pg14"
            with self.assertRaises(deploy.DeploymentError):
                op.apply(manifest())
            self.assertFalse(any(call[0] == "stop" for call in op.calls))
            self.assertFalse(any(call[0] == "images" and call[1] for call in op.calls))
            self.assertFalse(any(call[0] == "helper" and call[1] == "migrate" for call in op.calls))

    def test_adoption_does_not_record_a_pg14_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".env").write_text("POSTGRES_PASSWORD=synthetic\n")
            op = FixtureOperator(root)
            op.state.mkdir(mode=0o700)
            op.app_started = True
            op.db_image = "pgvector/pgvector:pg14"
            with self.assertRaises(deploy.DeploymentError):
                op.adopt(manifest())
            self.assertFalse(op.current_path.exists())


class BackupDurabilityTests(unittest.TestCase):
    class BackupIOOperator(FixtureOperator):
        def compose(self, release, *args, **kwargs):
            self.calls.append(("compose", tuple(args)))
            if "psql" in args:
                return self.db_version_result
            output = kwargs.get("output")
            if "pg_dump" in args:
                output.write(b"synthetic database dump")
            return ""

        def helper(self, release, service, *args, **kwargs):
            self.calls.append(("helper", service, tuple(args)))
            if service == "backup":
                output = kwargs["output"]
                archive = io.BytesIO()
                with tarfile.open(fileobj=archive, mode="w:gz") as tar:
                    payload = b"synthetic uploads"
                    entry = tarfile.TarInfo("uploads.txt")
                    entry.size = len(payload)
                    tar.addfile(entry, io.BytesIO(payload))
                output.write(archive.getvalue())
            return ""

        def backup(self, release, destination):
            return deploy.Operator.backup(self, release, destination)

    def test_backup_fsyncs_archive_directory_and_parent_before_return(self):
        with tempfile.TemporaryDirectory() as tmp:
            op = self.BackupIOOperator(tmp)
            op.state.mkdir(mode=0o700)
            destination = op.state / "backup-fixture"
            original = deploy.fsync_directory
            fsynced = []

            def record_fsync(path):
                fsynced.append(Path(path))
                return original(path)

            with patch.object(deploy, "fsync_directory", record_fsync):
                checksums = op.backup(manifest(), destination)

            self.assertEqual(set(checksums), {"database.dump", "uploads.tar.gz"})
            self.assertIn(destination, fsynced)
            self.assertIn(op.state, fsynced)
            self.assertEqual(fsynced[-2:], [destination, op.state])
            self.assertTrue((destination / "database.dump").stat().st_size)

    def test_backup_directory_fsync_failure_blocks_migration(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".env").write_text("POSTGRES_PASSWORD=synthetic\n")
            op = self.BackupIOOperator(root)
            op.state.mkdir(mode=0o700)
            original = deploy.fsync_directory

            def fail_backup_directory(path):
                if Path(path).name.startswith("backup-"):
                    raise OSError("synthetic backup directory fsync failure")
                return original(path)

            with patch.object(deploy, "fsync_directory", fail_backup_directory):
                with self.assertRaises((OSError, deploy.DeploymentError)):
                    op.apply(manifest())

            self.assertFalse(any(call[0] == "helper" and call[1] == "migrate" for call in op.calls))
            self.assertTrue(op.journal_path.exists())


class ProtectedStateTests(unittest.TestCase):
    def test_locked_state_and_atomic_json_are_private_and_replace_cleanly(self):
        with tempfile.TemporaryDirectory() as tmp:
            op = deploy.Operator(tmp, PROJECT, NAMESPACE)
            with op.locked():
                self.assertEqual(op.state.stat().st_mode & 0o777, 0o700)
                deploy.atomic_json(op.current_path, manifest())
                self.assertEqual(op.current_path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(json.loads(op.current_path.read_text()), manifest())
                self.assertFalse(op.current_path.with_suffix(".tmp").exists())

    def test_lock_rejects_a_concurrent_operator(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = deploy.Operator(tmp, PROJECT, NAMESPACE)
            second = deploy.Operator(tmp, PROJECT, NAMESPACE)
            with first.locked():
                with self.assertRaisesRegex(deploy.DeploymentError, "Another deployment operation"):
                    with second.locked():
                        self.fail("second operator unexpectedly acquired lock")

    def test_lock_fsyncs_install_directory_before_yielding(self):
        with tempfile.TemporaryDirectory() as tmp:
            op = deploy.Operator(tmp, PROJECT, NAMESPACE)
            original = deploy.fsync_directory
            events = []

            def record_fsync(path):
                events.append(("fsync", Path(path)))
                return original(path)

            with patch.object(deploy, "fsync_directory", record_fsync):
                with op.locked():
                    events.append(("yield", None))

            self.assertEqual(events[0], ("fsync", op.directory))
            self.assertEqual(events[1], ("yield", None))
            self.assertTrue(op.state.is_dir())


class ImageAndPreflightTests(unittest.TestCase):
    def test_image_labels_and_platform_must_match_manifest(self):
        for name, update in (
            ("architecture", {"Architecture": "arm64"}),
            ("operating system", {"Os": "windows"}),
            ("revision", {"Config": {"Labels": {"org.opencontainers.image.revision": "f" * 40,
                                                    "io.collectiveui.migrations-sha256": MIGRATIONS}}}),
            ("migration fingerprint", {"Config": {"Labels": {"org.opencontainers.image.revision": REVISION,
                                                                  "io.collectiveui.migrations-sha256": "f" * 64}}}),
        ):
            with self.subTest(mismatch=name), tempfile.TemporaryDirectory() as tmp:
                op = FixtureOperator(tmp)
                inspect = {"Architecture": "amd64", "Os": "linux", "Config": {"Labels": {
                    "org.opencontainers.image.revision": REVISION,
                    "io.collectiveui.migrations-sha256": MIGRATIONS,
                }}}
                inspect.update(update)
                op.inspect = inspect
                # Exercise the production image_ids implementation while substituting only docker commands.
                with self.assertRaises(deploy.DeploymentError):
                    deploy.Operator.image_ids(op, manifest(), pull=False)

    def test_preflight_accepts_only_synthetic_stock_compose_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            # Operator canonicalizes the installation; macOS temporary paths use a /var alias.
            root = Path(tmp).resolve()
            (root / ".env").write_text("POSTGRES_PASSWORD=synthetic\n")
            (root / ".env").chmod(0o600)
            (root / "docker-compose.release.yml").write_text("services: fixture\n")
            (root / "certs").mkdir()
            release = manifest()
            config = stock_config(release, root)
            op = PreflightOperator(root, config)
            deploy.Operator.preflight(op, release)
            self.assertTrue(any("config" in args for args in op.compose_calls))

            bad = stock_config(release, root)
            bad["services"]["web"]["image"] = "docker.io/other/image@sha256:" + WEB_DIGEST
            op = PreflightOperator(root, bad)
            with self.assertRaisesRegex(deploy.DeploymentError, "manifest"):
                deploy.Operator.preflight(op, release)

            bad_mounts = stock_config(release, root)
            bad_mounts["services"]["web"]["volumes"].pop()
            op = PreflightOperator(root, bad_mounts)
            with self.assertRaisesRegex(deploy.DeploymentError, "persistent/certificate mount"):
                deploy.Operator.preflight(op, release)


    def test_deployed_runtime_configuration_change_blocks_update_preflight(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            environment = root / ".env"
            environment.write_text("POSTGRES_PASSWORD=synthetic\n")
            environment.chmod(0o600)
            (root / "docker-compose.release.yml").write_text("services: fixture\n")
            operator = PreflightOperator(root, stock_config(manifest(), root))
            deploy.Operator.preflight(operator, manifest())
            operator.state.mkdir(mode=0o700)
            deploy.atomic_json(operator.identity_path, operator.identity)
            environment.write_text("POSTGRES_PASSWORD=changed-synthetic\n")
            with self.assertRaisesRegex(deploy.DeploymentError, "runtime .env changed"):
                deploy.Operator.preflight(operator, manifest())


def stock_config(release, directory):
    services = {}
    for name in ("db", "web", "worker", "migrate", "backup"):
        mounts = []
        if name == "db":
            mounts = [{"type": "volume", "source": "pgdata", "target": "/var/lib/postgresql/data"}]
        elif name == "backup":
            mounts = [{"type": "volume", "source": "uploads", "target": "/data/uploads"}]
        else:
            mounts = [
                {"type": "volume", "source": "uploads", "target": "/data/uploads"},
                {"type": "bind", "source": str(directory / "certs"), "target": "/etc/portal/certs", "read_only": True},
            ]
        services[name] = {"image": ("pgvector/pgvector:pg16@sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a" if name == "db" else
                                     release["images"]["web" if name == "web" else "worker"]), "volumes": mounts}
    services["worker"]["command"] = ["node", "--import", "tsx", "src/worker/index.ts"]
    services["migrate"]["command"] = ["node", "--import", "tsx", "src/db/migrate.ts"]
    services["backup"]["command"] = ["tar", "-C", "/data/uploads", "-czf", "-", "."]
    return {"services": services, "volumes": {
        "pgdata": {"name": f"{PROJECT}_pgdata"}, "uploads": {"name": f"{PROJECT}_uploads"},
    }}


class PreflightOperator(FixtureOperator):
    def __init__(self, directory, config):
        super().__init__(directory, config=config)
        self.compose_calls = []

    def command(self, arguments, **kwargs):
        if arguments[:3] == ["docker", "compose", "version"]:
            return "fixture compose"
        if arguments[:3] == ["docker", "info", "--format"]:
            return "fixture-daemon"
        return super().command(arguments, **kwargs)

    def compose(self, release, *args, **kwargs):
        self.compose_calls.append(args)
        if "config" in args:
            return json.dumps(self.config)
        return ""


class ApplySafetyTests(unittest.TestCase):
    def _operator(self, tmp, fail_at=None):
        root = Path(tmp)
        (root / ".env").write_text("POSTGRES_PASSWORD=synthetic\n")
        op = FixtureOperator(root)
        op.state.mkdir(mode=0o700)
        op.fail_at = fail_at
        return op

    def test_pull_failure_happens_before_any_stop(self):
        with tempfile.TemporaryDirectory() as tmp:
            op = self._operator(tmp, "pull")
            with self.assertRaises(deploy.DeploymentError):
                op.apply(manifest())
            self.assertFalse(any(kind == "stop" for kind, *_ in op.calls))
            self.assertFalse(op.journal_path.exists())

    def test_backup_failure_blocks_migration(self):
        with tempfile.TemporaryDirectory() as tmp:
            op = self._operator(tmp, "backup")
            with self.assertRaises(deploy.DeploymentError):
                op.apply(manifest())
            self.assertTrue(any(kind == "backup" for kind, *_ in op.calls))
            self.assertFalse(any(call[0] == "helper" and call[1] == "migrate" for call in op.calls))
            self.assertTrue(op.journal_path.exists())

    def test_migration_or_readiness_failure_stops_pair_and_keeps_pending_record(self):
        for failure in ("migration", "readiness"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                op = self._operator(tmp, failure)
                with self.assertRaises(deploy.DeploymentError):
                    op.apply(manifest())
                stop_calls = [call for call in op.calls if call[0] == "stop"]
                self.assertGreaterEqual(len(stop_calls), 2, "application pair should be stopped before work and after failure")
                self.assertTrue(op.journal_path.exists())
                self.assertFalse(op.current_path.exists())
                self.assertFalse(any(call[0] == "start" and call[1] == "sha-" + PREVIOUS_REVISION for call in op.calls))

    def test_pending_journal_blocks_another_apply(self):
        with tempfile.TemporaryDirectory() as tmp:
            op = self._operator(tmp, "backup")
            with self.assertRaises(deploy.DeploymentError):
                op.apply(manifest())
            op.fail_at = None
            with self.assertRaisesRegex(deploy.DeploymentError, "Unfinished deployment"):
                op.apply(manifest())

    def test_success_records_current_manifest_and_backup_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            op = self._operator(tmp)
            op.apply(manifest())
            self.assertEqual(json.loads(op.current_path.read_text()), manifest())
            self.assertFalse(op.journal_path.exists())
            backups = list(op.state.glob("backup-*"))
            self.assertEqual(len(backups), 1)
            receipt = json.loads((backups[0] / "receipt.json").read_text())
            self.assertEqual(receipt["target"], manifest())
            self.assertEqual(set(receipt["checksums"]), {"database.dump", "uploads.tar.gz"})

    def test_adoption_rejects_mismatched_running_images(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".env").write_text("POSTGRES_PASSWORD=synthetic\n")
            op = self._operator(tmp, "adopt-mismatch")
            with self.assertRaises(deploy.DeploymentError):
                op.adopt(manifest())
            self.assertFalse(op.current_path.exists())

    def test_same_schema_hash_failure_does_not_automatically_start_previous_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            op = self._operator(tmp, "migration")
            previous = manifest(revision=PREVIOUS_REVISION, migrations=MIGRATIONS)
            op.current_path.parent.mkdir(mode=0o700, exist_ok=True)
            deploy.atomic_json(op.current_path, previous)
            op.app_started = True
            with self.assertRaises(deploy.DeploymentError):
                op.apply(manifest())
            self.assertFalse(any(call[0] == "start" for call in op.calls))
            self.assertTrue(op.journal_path.exists())


class RollbackSafetyTests(unittest.TestCase):
    def _pending(self, root, *, previous=None, env=None):
        root = Path(root)
        (root / ".env").write_text("POSTGRES_PASSWORD=synthetic\n")
        op = FixtureOperator(root)
        op.state.mkdir(mode=0o700)
        destination = op.state / "backup-fixture"
        destination.mkdir(mode=0o700)
        (destination / "database.dump").write_bytes(b"database fixture")
        with tarfile.open(destination / "uploads.tar.gz", "w:gz") as archive:
            content = b"uploads fixture"
            info = tarfile.TarInfo("uploads.txt")
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
        checksums = {
            "database.dump": hashlib.sha256((destination / "database.dump").read_bytes()).hexdigest(),
            "uploads.tar.gz": hashlib.sha256((destination / "uploads.tar.gz").read_bytes()).hexdigest(),
        }
        journal = {
            "phase": "backed-up", "operation": "fixture-operation", "target": manifest(), "previous": previous,
            "backup": str(destination), "env_sha256": hashlib.sha256((root / ".env").read_bytes()).hexdigest(),
            "checksums": checksums,
        }
        deploy.atomic_json(op.journal_path, journal)
        return op, destination, journal

    def test_rollback_requires_explicit_restore_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            op, _, _ = self._pending(tmp, previous=manifest(revision=PREVIOUS_REVISION))
            with self.assertRaisesRegex(deploy.DeploymentError, "pass --restore-data"):
                op.rollback(False)

    def test_changed_env_or_backup_checksum_blocks_restore(self):
        for tamper in ("env", "backup"):
            with self.subTest(tamper=tamper), tempfile.TemporaryDirectory() as tmp:
                previous = manifest(revision=PREVIOUS_REVISION)
                op, destination, _ = self._pending(tmp, previous=previous)
                if tamper == "env":
                    op.env_file.write_text("POSTGRES_PASSWORD=changed\n")
                else:
                    (destination / "database.dump").write_bytes(b"tampered")
                with self.assertRaises(deploy.DeploymentError):
                    op.rollback(True)
                self.assertFalse(any(call[0] == "compose" for call in op.calls))
                self.assertFalse(any(call[0] == "start" for call in op.calls))

    def test_missing_previous_release_refuses_rollback(self):
        with tempfile.TemporaryDirectory() as tmp:
            op, _, _ = self._pending(tmp, previous=None)
            with self.assertRaisesRegex(deploy.DeploymentError, "No complete backup and previous"):
                op.rollback(True)

    def test_restore_orders_database_then_uploads_then_previous_pair(self):
        with tempfile.TemporaryDirectory() as tmp:
            previous = manifest(revision=PREVIOUS_REVISION)
            op, _, _ = self._pending(tmp, previous=previous)
            op.rollback(True)
            operations = [call for call in op.calls if call[0] in {"compose", "helper", "start"}]
            drop_db = next(i for i, call in enumerate(operations)
                           if call[0] == "compose" and "dropdb" in call[1])
            create_db = next(i for i, call in enumerate(operations)
                             if call[0] == "compose" and "createdb" in call[1])
            db_restore = next(i for i, call in enumerate(operations)
                              if call[0] == "compose" and "pg_restore" in call[1])
            uploads_restore = next(i for i, call in enumerate(operations)
                                   if call[0] == "helper" and any("tar" in arg for arg in call[2]))
            previous_start = next(i for i, call in enumerate(operations)
                                  if call[0] == "start" and call[1] == previous["version"])
            self.assertLess(drop_db, create_db)
            self.assertLess(create_db, db_restore)
            self.assertLess(db_restore, uploads_restore)
            self.assertLess(uploads_restore, previous_start)
            self.assertFalse(op.journal_path.exists())
            self.assertEqual(json.loads(op.current_path.read_text()), previous)


class RecoveryTests(unittest.TestCase):
    def _pending(self, root, phase):
        root = Path(root)
        (root / ".env").write_text("POSTGRES_PASSWORD=synthetic\n")
        op = FixtureOperator(root)
        op.state.mkdir(mode=0o700)
        previous = manifest(revision=PREVIOUS_REVISION)
        journal = {
            "phase": phase,
            "operation": "fixture-operation",
            "target": manifest(),
            "previous": previous,
            "backup": str(op.state / "backup-fixture"),
            "env_sha256": hashlib.sha256(op.env_file.read_bytes()).hexdigest(),
        }
        deploy.atomic_json(op.journal_path, journal)
        return op, previous

    def test_early_phase_recovery_restarts_previous_pair_without_data_restore(self):
        with tempfile.TemporaryDirectory() as tmp:
            op, previous = self._pending(tmp, "backing-up")
            op.recover()
            self.assertTrue(any(call[0] == "start" and call[1] == previous["version"] for call in op.calls))
            self.assertFalse(op.journal_path.exists())
            self.assertFalse(any(call[0] == "compose" and "pg_restore" in call[1] for call in op.calls))

    def test_recovery_refuses_after_migration_phase_starts(self):
        with tempfile.TemporaryDirectory() as tmp:
            op, _ = self._pending(tmp, "migration-started")
            with self.assertRaisesRegex(deploy.DeploymentError, "Migration may have started"):
                op.recover()
            self.assertTrue(op.journal_path.exists())
            self.assertFalse(any(call[0] == "start" for call in op.calls))


class HelperCleanupTests(unittest.TestCase):
    class CleanupOperator(deploy.Operator):
        def __init__(self, directory):
            super().__init__(directory, PROJECT, NAMESPACE)
            self.calls = []
            self.inspect_count = 0

        def command(self, arguments, **kwargs):
            args = tuple(arguments)
            self.calls.append(args)
            if args[:2] == ("docker", "ps"):
                return "helper-id\n"
            if args[:2] == ("docker", "inspect"):
                self.inspect_count += 1
                running = self.inspect_count == 1
                return json.dumps([{
                    "Config": {"Labels": {"com.docker.compose.project": PROJECT}},
                    "State": {"Running": running},
                }])
            return ""

    def test_stops_and_removes_a_helper_after_confirming_it_stopped(self):
        with tempfile.TemporaryDirectory() as tmp:
            op = self.CleanupOperator(tmp)
            op.stop_helpers()
            self.assertTrue(any(call[:2] == ("docker", "stop") for call in op.calls))
            self.assertTrue(any(call[:2] == ("docker", "rm") for call in op.calls))


class AutoRemoveRaceTests(unittest.TestCase):
    def test_retiring_helper_cannot_write_and_does_not_need_second_removal(self):
        class RemovingOperator(deploy.Operator):
            def command(self, arguments, **kwargs):
                if arguments[1] == "ps":
                    return "fixture-helper\n"
                if arguments[1] == "inspect":
                    return json.dumps([{"Config": {"Labels": {"com.docker.compose.project": PROJECT}},
                                        "State": {"Running": False, "Status": "removing"}}])
                raise AssertionError("A stopped helper already being removed must not be stopped/removed again")
        with tempfile.TemporaryDirectory() as temporary:
            RemovingOperator(temporary, PROJECT, NAMESPACE).stop_helpers()


class PrivateDiagnosticsTests(unittest.TestCase):
    def test_failed_command_keeps_bounded_secret_diagnostics_private(self):
        with tempfile.TemporaryDirectory() as temporary:
            operator = deploy.Operator(temporary, PROJECT, NAMESPACE)
            result = deploy.subprocess.CompletedProcess(["docker"], 1, stdout=b"synthetic-secret", stderr=b"synthetic-error")
            with operator.locked(), patch.object(deploy.subprocess, "run", return_value=result):
                with self.assertRaises(deploy.DeploymentError) as raised:
                    operator.command(["docker", "info"])
                self.assertNotIn("synthetic-secret", str(raised.exception))
                diagnostic = operator.state / "last-error.log"
                self.assertEqual(diagnostic.stat().st_mode & 0o777, 0o600)
                self.assertIn(b"synthetic-error", diagnostic.read_bytes())
                self.assertIn(b"synthetic-secret", diagnostic.read_bytes())


if __name__ == "__main__":
    unittest.main()
