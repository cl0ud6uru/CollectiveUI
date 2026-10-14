#!/usr/bin/env python3
"""Real, disposable core update/restore test; no registry writes or real credentials.

Local image IDs substitute for published digest metadata (covered by offline tests).
The operator's real stop/backup/migrate/health/journal/restore commands run unchanged.
"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("deploy_release", ROOT / "scripts/deploy-release.py")
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)
LOCAL_IMAGES = {"web": os.environ.get("WEB_IMAGE", "collectiveui-web:test"),
                "worker": os.environ.get("WORKER_IMAGE", "collectiveui-worker:test")}


def manifest(version):
    revision = "a" * 40
    return {"format": 1, "revision": revision, "version": version or "sha-" + revision,
            "migrations_sha256": "b" * 64,
            "images": {name: f"docker.io/synthetic-fixture/collectiveui-{name}@sha256:{'c' * 64}" for name in LOCAL_IMAGES}}


class LocalOperator(deploy.Operator):
    def command(self, arguments, *, manifest=None, **kwargs):
        if manifest:
            manifest = dict(manifest, images=LOCAL_IMAGES)
        return super().command(arguments, manifest=manifest, **kwargs)

    def image_ids(self, manifest, pull=True):
        # Never pull/publish fake registry references. Actual image identity remains checked at runtime.
        return {name: json.loads(self.command(["docker", "image", "inspect", reference]))[0]["Id"]
                for name, reference in LOCAL_IMAGES.items()}

    def preflight(self, release):
        # Render real stock Compose with local test images; preserve the actual storage/command checks.
        return super().preflight(dict(release, images=LOCAL_IMAGES))


def main():
    os.umask(0o077)
    project = "collective-deploy-fixture-" + str(os.getpid()) + "-" + str(time.time_ns())
    with tempfile.TemporaryDirectory(prefix="collective-deploy-fixture-") as temporary:
        directory = Path(temporary)
        compose = (ROOT / "docker-compose.release.yml").read_text()
        # The isolated fixture has no ingress, broker, external network or existing installation volumes.
        compose = compose.replace('    ports:\n      - "${WEB_BIND:-0.0.0.0}:${PORT:-3000}:3000"\n', '')
        compose += "\nnetworks:\n  default:\n    internal: true\n"
        (directory / "docker-compose.release.yml").write_text(compose)
        (directory / "certs").mkdir()
        (directory / ".env").write_text(
            "POSTGRES_PASSWORD=synthetic-deploy-fixture-only\nAUTH_SECRET=synthetic-deploy-fixture-only\n"
            "ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n"
            "AUTH_URL=http://localhost:3000\nAUTH_LOCAL_ENABLED=true\nAUTH_ENTRA_ENABLED=false\nLDAP_ENABLED=false\n")
        operator = LocalOperator(directory, project, "synthetic-fixture", timeout=180)
        original, target = manifest(None), manifest("v0.0.1")
        try:
            with operator.locked():
                operator.apply(original)
            operator.compose(original, "exec", "-T", "db", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "portal", "-d", "portal", "-c",
                             "CREATE TABLE deployment_smoke (value text); INSERT INTO deployment_smoke VALUES ('original');")
            operator.compose(original, "--profile", "maintenance", "run", "--rm", "--no-deps", "-T", "backup", "sh", "-c",
                             "printf original > /data/uploads/deployment-smoke.txt")
            with operator.locked():
                operator.apply(target)
            backups = sorted(operator.state.glob("backup-*"))
            receipt = deploy.read_json(backups[-1] / "receipt.json")
            operator.compose(target, "exec", "-T", "db", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "portal", "-d", "portal", "-c",
                             "UPDATE deployment_smoke SET value='new'; CREATE SCHEMA deployment_smoke_new; CREATE TABLE deployment_smoke_new.extra (id int);")
            operator.compose(target, "--profile", "maintenance", "run", "--rm", "--no-deps", "-T", "backup", "sh", "-c",
                             "printf new > /data/uploads/deployment-smoke.txt; printf extra > /data/uploads/new.txt")
            # A killed CLI can leave its labeled one-off helper running. Fence it before any restoration.
            operator.compose(target, "--profile", "maintenance", "run", "--rm", "--no-deps", "--detach", "--label",
                             f"io.collectiveui.deploy-project={project}", "--label", "io.collectiveui.operation=fixture-abandoned", "backup", "sleep", "120")
            with operator.locked():
                deploy.atomic_json(operator.journal_path, receipt)
                operator.rollback(True)
            restored = operator.compose(original, "exec", "-T", "db", "psql", "-X", "-At", "-U", "portal", "-d", "portal", "-c",
                                        "SELECT value FROM deployment_smoke; SELECT NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='deployment_smoke_new');")
            assert restored.strip().splitlines() == ["original", "t"], restored
            uploads = operator.compose(original, "--profile", "maintenance", "run", "--rm", "--no-deps", "-T", "backup", "sh", "-c",
                                       "test ! -e /data/uploads/new.txt && cat /data/uploads/deployment-smoke.txt")
            assert uploads == "original", uploads
            assert deploy.read_json(operator.current_path) == original
            assert not operator.journal_path.exists()
            assert not operator.command(["docker", "ps", "--all", "--quiet", "--filter", f"label=io.collectiveui.deploy-project={project}"]).strip()
            print("Disposable update/restore smoke passed: healthy image pair, consistent DB/uploads, fresh-schema restore, helper fencing, previous state.")
        except BaseException:
            # Only public synthetic fixture credentials exist here; retain actionable CI failure evidence.
            diagnostic = operator.state / "last-error.log"
            if diagnostic.exists():
                print(diagnostic.read_text(errors="replace"), file=sys.stderr)
            raise
        finally:
            # Only the uniquely named disposable project owns these resources.
            operator.compose(target, "down", "--volumes", "--remove-orphans", timeout=120)


if __name__ == "__main__":
    main()
