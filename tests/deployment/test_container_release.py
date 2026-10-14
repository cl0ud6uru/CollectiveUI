import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
HELPER_PATH = REPOSITORY_ROOT / "scripts" / "container-release.py"
SPEC = importlib.util.spec_from_file_location("container_release", HELPER_PATH)
release = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(release)


REVISION = "a" * 40
MIGRATIONS = "b" * 64
WEB_DIGEST = "sha256:" + "c" * 64
WORKER_DIGEST = "sha256:" + "d" * 64


class MissingManifestTests(unittest.TestCase):
    reference = f"docker.io/example/collectiveui-web:sha-{REVISION}"

    def test_accepts_observed_buildx_absence_for_the_requested_reference(self):
        release.verify_missing_manifest(self.reference, f"ERROR: {self.reference}: not found\n")

    def test_accepts_complete_legacy_manifest_absence_diagnostics(self):
        for output in (
            f"ERROR: {self.reference}: manifest unknown",
            f"ERROR: {self.reference}: manifest unknown: manifest unknown",
            f"ERROR: {self.reference}: no such manifest",
            "ERROR: manifest unknown",
            "ERROR: manifest unknown: manifest unknown",
            f"ERROR: no such manifest: {self.reference}",
        ):
            with self.subTest(output=output):
                release.verify_missing_manifest(self.reference, output)

    def test_rejects_auth_network_and_ambiguous_diagnostics(self):
        for output in (
            "ERROR: unauthorized: authentication required",
            "ERROR: failed to authorize: failed to fetch oauth token: 401 Unauthorized",
            "ERROR: unexpected status from HEAD request: 403 Forbidden",
            "ERROR: unexpected status from HEAD request: 429 Too Many Requests",
            "ERROR: dial tcp: lookup registry-1.docker.io: no such host",
            "ERROR: TLS handshake timeout",
            "ERROR: manifest unknown: failed to authorize",
            "ERROR: certificate file not found",
            "not found",
            "",
            f"ERROR: {self.reference}-other: not found",
            f"ERROR: {self.reference}: not found\nERROR: unauthorized: authentication required",
        ):
            with self.subTest(output=output), self.assertRaises(release.ReleaseError):
                release.verify_missing_manifest(self.reference, output)

    def run_workflow_guard(self, responses):
        """Run the checked-in publishing guard with a synthetic Docker CLI."""
        workflow = (REPOSITORY_ROOT / ".github/workflows/docker-release.yml").read_text()
        step = workflow.split("      - name: Refuse to overwrite existing version tags\n", 1)[1]
        block = step.split("        run: |\n", 1)[1].split("\n      - name:", 1)[0]
        script = "\n".join(line.removeprefix("          ") for line in block.splitlines())
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            docker = root / "docker"
            docker.write_text(
                "#!/usr/bin/env python3\n"
                "import json, os, sys\n"
                "assert sys.argv[1:4] == ['buildx', 'imagetools', 'inspect']\n"
                "ref = sys.argv[4]\n"
                "with open(os.environ['INSPECT_CALLS'], 'a') as log: log.write(ref + '\\n')\n"
                "result = json.loads(os.environ['INSPECT_RESULTS'])[ref]\n"
                "print(result['output'])\n"
                "sys.exit(result['status'])\n",
                encoding="utf-8",
            )
            docker.chmod(0o755)
            calls = root / "calls"
            result = subprocess.run(
                ["bash", "-c", script], cwd=REPOSITORY_ROOT, capture_output=True, text=True,
                env=os.environ | {
                    "PATH": f"{root}{os.pathsep}{os.environ['PATH']}",
                    "DOCKERHUB_NAMESPACE": "example", "VERSION": f"sha-{REVISION}",
                    "INSPECT_CALLS": str(calls), "INSPECT_RESULTS": json.dumps(responses),
                },
            )
            return result, calls.read_text().splitlines()

    def absent_pair(self):
        return {
            f"docker.io/example/{image}:sha-{REVISION}": {
                "status": 1, "output": f"ERROR: docker.io/example/{image}:sha-{REVISION}: not found",
            }
            for image in ("collectiveui-web", "collectiveui-worker")
        }

    def test_workflow_accepts_only_when_both_tags_are_absent(self):
        responses = self.absent_pair()
        result, calls = self.run_workflow_guard(responses)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, list(responses))

    def test_workflow_stops_on_existing_tags_auth_and_network_errors(self):
        for image in ("collectiveui-web", "collectiveui-worker"):
            reference = f"docker.io/example/{image}:sha-{REVISION}"
            for status, output, diagnostic in (
                (0, "manifest metadata", "Refusing to overwrite existing tag"),
                (1, "ERROR: unauthorized: authentication required", "Could not prove"),
                (1, "ERROR: TLS handshake timeout", "Could not prove"),
            ):
                with self.subTest(image=image, output=output):
                    responses = self.absent_pair()
                    responses[reference] = {"status": status, "output": output}
                    result, calls = self.run_workflow_guard(responses)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(diagnostic, result.stderr)
                    self.assertEqual(calls[-1], reference)


class EventTrustTests(unittest.TestCase):
    def test_pull_request_is_test_only(self):
        result = release.validate_event(
            event_name="pull_request",
            ref="refs/pull/42/merge",
            sha=REVISION,
            payload={"pull_request": {"head": {"sha": "e" * 40}}},
            checkout_sha=REVISION,
            main_contains_sha=False,
        )
        self.assertEqual(result["publish"], "false")
        self.assertEqual(result["version"], f"sha-{REVISION}")

    def test_only_verified_main_push_publishes(self):
        args = dict(
            event_name="push",
            ref="refs/heads/main",
            sha=REVISION,
            payload={"ref": "refs/heads/main", "after": REVISION},
            checkout_sha=REVISION,
            main_contains_sha=True,
        )
        self.assertEqual(release.validate_event(**args)["publish"], "true")
        for change in (
            {"ref": "refs/heads/feature"},
            {"payload": {"ref": "refs/heads/main", "after": "f" * 40}},
            {"main_contains_sha": False},
            {"checkout_sha": "e" * 40},
        ):
            with self.subTest(change=change), self.assertRaises(release.ReleaseError):
                release.validate_event(**(args | change))

    def test_only_stable_published_main_ancestor_release_publishes(self):
        args = dict(
            event_name="release",
            ref="refs/tags/v1.2.3",
            sha=REVISION,
            payload={
                "action": "published",
                "release": {"tag_name": "v1.2.3", "draft": False, "prerelease": False},
            },
            checkout_sha=REVISION,
            main_contains_sha=True,
            tag_commit=REVISION,
        )
        self.assertEqual(release.validate_event(**args)["version"], "v1.2.3")
        bad_payloads = [
            {"action": "created", "release": args["payload"]["release"]},
            {"action": "published", "release": args["payload"]["release"] | {"draft": True}},
            {"action": "published", "release": args["payload"]["release"] | {"prerelease": True}},
            {"action": "published", "release": args["payload"]["release"] | {"tag_name": "v1.2.3-rc.1"}},
        ]
        for payload in bad_payloads:
            with self.subTest(payload=payload), self.assertRaises(release.ReleaseError):
                release.validate_event(**(args | {"payload": payload}))
        with self.assertRaises(release.ReleaseError):
            release.validate_event(**(args | {"tag_commit": "e" * 40}))
        with self.assertRaises(release.ReleaseError):
            release.validate_event(**(args | {"main_contains_sha": False}))


class MetadataTests(unittest.TestCase):
    def test_stable_versions_reject_prereleases_and_noncanonical_numbers(self):
        self.assertTrue(release.is_stable_version("v0.0.0"))
        for version in ("1.2.3", "v01.2.3", "v1.2", "v1.2.3-rc.1", "latest"):
            with self.subTest(version=version):
                self.assertFalse(release.is_stable_version(version))

    def test_migration_hash_covers_relative_filenames_and_contents(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            migration_dir = root / "src/db/migrations"
            migration_dir.mkdir(parents=True)
            (migration_dir / "0001.sql").write_text("select 1;", encoding="utf-8")
            (migration_dir / "0002.sql").write_text("select 2;", encoding="utf-8")
            initial = release.migration_fingerprint(root)
            self.assertEqual(initial, release.migration_fingerprint(root))
            (migration_dir / "0002.sql").write_text("select 3;", encoding="utf-8")
            self.assertNotEqual(initial, release.migration_fingerprint(root))
            (migration_dir / "0003.sql").write_text("select 3;", encoding="utf-8")
            self.assertNotEqual(initial, release.migration_fingerprint(root))

    def test_manifest_has_digest_pinned_web_and_worker_images(self):
        manifest = release.make_manifest(
            namespace="collectiveui",
            revision=REVISION,
            version=f"sha-{REVISION}",
            migrations_sha256=MIGRATIONS,
            web_digest=WEB_DIGEST,
            worker_digest=WORKER_DIGEST,
        )
        self.assertEqual(set(manifest), {"format", "revision", "version", "migrations_sha256", "images"})
        self.assertEqual(manifest["format"], 1)
        self.assertEqual(manifest["images"], {
            "web": f"docker.io/collectiveui/collectiveui-web@{WEB_DIGEST}",
            "worker": f"docker.io/collectiveui/collectiveui-worker@{WORKER_DIGEST}",
        })
        for bad in (
            {"namespace": "UnknownOwner"},
            {"version": "latest"},
            {"web_digest": "sha256:bad"},
        ):
            with self.subTest(bad=bad), self.assertRaises(release.ReleaseError):
                release.make_manifest(**({
                    "namespace": "collectiveui",
                    "revision": REVISION,
                    "version": f"sha-{REVISION}",
                    "migrations_sha256": MIGRATIONS,
                    "web_digest": WEB_DIGEST,
                    "worker_digest": WORKER_DIGEST,
                } | bad))

    def test_loaded_archive_must_match_tested_ids_and_labels(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = {
                "revision": REVISION,
                "migrations_sha256": MIGRATIONS,
                "images": {
                    "web": {"id": "sha256:" + "1" * 64},
                    "worker": {"id": "sha256:" + "2" * 64},
                },
            }
            (root / "evidence.json").write_text(json.dumps(evidence), encoding="utf-8")
            for name, image_id in (("web", "sha256:" + "1" * 64), ("worker", "sha256:" + "2" * 64)):
                inspect = [{
                    "Id": image_id,
                    "Os": "linux",
                    "Architecture": "amd64",
                    "Config": {"Labels": {
                        release.LABEL_REVISION: REVISION,
                        release.LABEL_MIGRATIONS: MIGRATIONS,
                    }},
                }]
                (root / f"{name}.json").write_text(json.dumps(inspect), encoding="utf-8")

            release.verify_loaded_images(
                root / "evidence.json", root / "web.json", root / "worker.json",
                revision=REVISION, migrations_sha256=MIGRATIONS,
            )
            worker = [{
                "Id": "sha256:" + "3" * 64,
                "Os": "linux",
                "Architecture": "amd64",
                "Config": {"Labels": {
                    release.LABEL_REVISION: REVISION,
                    release.LABEL_MIGRATIONS: MIGRATIONS,
                }},
            }]
            (root / "worker.json").write_text(json.dumps(worker), encoding="utf-8")
            with self.assertRaises(release.ReleaseError):
                release.verify_loaded_images(
                    root / "evidence.json", root / "web.json", root / "worker.json",
                    revision=REVISION, migrations_sha256=MIGRATIONS,
                )

            worker[0]["Id"] = "sha256:" + "2" * 64
            worker[0]["Architecture"] = "arm64"
            (root / "worker.json").write_text(json.dumps(worker), encoding="utf-8")
            with self.assertRaises(release.ReleaseError):
                release.verify_loaded_images(
                    root / "evidence.json", root / "web.json", root / "worker.json",
                    revision=REVISION, migrations_sha256=MIGRATIONS,
                )


if __name__ == "__main__":
    unittest.main()
