#!/usr/bin/env python3
"""Small, dependency-free trust and metadata helpers for the Docker Hub release workflow."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


SHA_RE = re.compile(r"^[0-9a-f]{40}$")
VERSION_RE = re.compile(r"^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
NAMESPACE_RE = re.compile(r"^[a-z0-9]+(?:[._-][a-z0-9]+)*$")
LABEL_REVISION = "org.opencontainers.image.revision"
LABEL_MIGRATIONS = "io.collectiveui.migrations-sha256"


class ReleaseError(ValueError):
    """Raised when release metadata or event trust checks are invalid."""


def is_stable_version(value: str) -> bool:
    return VERSION_RE.fullmatch(value) is not None


def migration_fingerprint(root: Path) -> str:
    """Hash every migration-tree file using an unambiguous path/content framing."""
    migrations = root / "src" / "db" / "migrations"
    if not migrations.is_dir():
        raise ReleaseError(f"migration directory not found: {migrations}")
    files = sorted(path for path in migrations.rglob("*") if path.is_file())
    if not files:
        raise ReleaseError("migration directory is empty")

    digest = hashlib.sha256()
    for path in files:
        relative = path.relative_to(root).as_posix().encode("utf-8")
        content = path.read_bytes()
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def validate_event(
    *,
    event_name: str,
    ref: str,
    sha: str,
    payload: dict[str, Any],
    checkout_sha: str,
    main_contains_sha: bool,
    tag_commit: str | None = None,
) -> dict[str, str]:
    """Return publish eligibility only for verified main pushes or stable releases."""
    if not SHA_RE.fullmatch(sha):
        raise ReleaseError("event revision must be a full lowercase 40-character commit SHA")
    if checkout_sha != sha:
        raise ReleaseError("checkout does not match the exact GitHub event revision")

    if event_name == "pull_request":
        if not ref.startswith("refs/pull/"):
            raise ReleaseError("pull_request event has an unexpected ref")
        return {"publish": "false", "revision": sha, "version": f"sha-{sha}"}

    if event_name == "push":
        if ref != "refs/heads/main" or payload.get("ref") != ref:
            raise ReleaseError("only a push to main can publish")
        if payload.get("after") != sha:
            raise ReleaseError("push payload revision does not match the event SHA")
        if not main_contains_sha:
            raise ReleaseError("event revision is not contained in fetched origin/main")
        return {"publish": "true", "revision": sha, "version": f"sha-{sha}"}

    if event_name == "release":
        release = payload.get("release")
        if not isinstance(release, dict):
            raise ReleaseError("release event payload is missing its release object")
        if payload.get("action") != "published" or release.get("draft") or release.get("prerelease"):
            raise ReleaseError("only a published, non-draft, non-prerelease release can publish")
        tag = release.get("tag_name")
        if not isinstance(tag, str) or not is_stable_version(tag):
            raise ReleaseError("release tag must be a stable vN.N.N version")
        if ref != f"refs/tags/{tag}":
            raise ReleaseError("release ref does not match the release tag")
        if tag_commit != sha:
            raise ReleaseError("release tag does not resolve to the exact event revision")
        if not main_contains_sha:
            raise ReleaseError("release tag revision is not contained in fetched origin/main")
        return {"publish": "true", "revision": sha, "version": tag}

    raise ReleaseError(f"unsupported event type: {event_name}")


def _git(*args: str) -> str:
    try:
        return subprocess.run(
            ["git", *args], check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        ).stdout.strip()
    except subprocess.CalledProcessError as error:
        raise ReleaseError(f"git {' '.join(args)} failed: {error.stderr.strip()}") from error


def event_check(event_name: str, ref: str, sha: str, event_path: Path) -> dict[str, str]:
    try:
        payload = json.loads(event_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ReleaseError(f"cannot read GitHub event payload: {error}") from error
    if not isinstance(payload, dict):
        raise ReleaseError("GitHub event payload must be a JSON object")

    checkout_sha = _git("rev-parse", "HEAD")
    main_contains_sha = False
    tag_commit: str | None = None
    if event_name == "push" and ref == "refs/heads/main":
        _git("fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main")
        main_contains_sha = subprocess.run(
            ["git", "merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode == 0
    elif event_name == "release":
        release = payload.get("release")
        tag = release.get("tag_name") if isinstance(release, dict) else None
        if isinstance(tag, str) and is_stable_version(tag):
            _git("fetch", "origin", "+refs/heads/main:refs/remotes/origin/main", f"+refs/tags/{tag}:refs/tags/{tag}")
            tag_commit = _git("rev-parse", f"refs/tags/{tag}^{{commit}}")
            main_contains_sha = subprocess.run(
                ["git", "merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            ).returncode == 0
    return validate_event(
        event_name=event_name,
        ref=ref,
        sha=sha,
        payload=payload,
        checkout_sha=checkout_sha,
        main_contains_sha=main_contains_sha,
        tag_commit=tag_commit,
    )


def validate_namespace(namespace: str) -> str:
    if len(namespace) > 255 or not NAMESPACE_RE.fullmatch(namespace):
        raise ReleaseError("Docker Hub namespace must be a lowercase repository owner name")
    return namespace


def verify_missing_manifest(reference: str, output: str) -> None:
    """Accept only complete, known absence diagnostics from a failed inspect."""
    # Buildx's resolver now emits "<requested reference>: not found". Do not
    # treat incidental "not found" text (or mixed auth/network errors) as proof.
    known_errors = {
        f"ERROR: {reference}: not found",
        f"ERROR: {reference}: manifest unknown",
        f"ERROR: {reference}: manifest unknown: manifest unknown",
        f"ERROR: {reference}: no such manifest",
        "ERROR: manifest unknown",
        "ERROR: manifest unknown: manifest unknown",
        f"ERROR: no such manifest: {reference}",
    }
    if output.strip() not in known_errors:
        raise ReleaseError(f"Could not prove that {reference} is absent: {output.strip()}")


def make_manifest(
    *, namespace: str, revision: str, version: str, migrations_sha256: str,
    web_digest: str, worker_digest: str,
) -> dict[str, Any]:
    validate_namespace(namespace)
    if not SHA_RE.fullmatch(revision):
        raise ReleaseError("revision must be a full lowercase 40-character commit SHA")
    if version != f"sha-{revision}" and not is_stable_version(version):
        raise ReleaseError("version must be sha-<full commit SHA> or stable vN.N.N")
    if not re.fullmatch(r"[0-9a-f]{64}", migrations_sha256):
        raise ReleaseError("migration fingerprint must be a 64-character SHA-256")
    for name, value in (("web", web_digest), ("worker", worker_digest)):
        if not DIGEST_RE.fullmatch(value):
            raise ReleaseError(f"{name} digest must be sha256 followed by 64 lowercase hex characters")

    registry = f"docker.io/{namespace}"
    return {
        "format": 1,
        "revision": revision,
        "version": version,
        "migrations_sha256": migrations_sha256,
        "images": {
            "web": f"{registry}/collectiveui-web@{web_digest}",
            "worker": f"{registry}/collectiveui-worker@{worker_digest}",
        },
    }


def verify_loaded_images(
    evidence_path: Path,
    web_inspect_path: Path,
    worker_inspect_path: Path,
    *,
    revision: str,
    migrations_sha256: str,
) -> None:
    try:
        evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
        web = json.loads(web_inspect_path.read_text(encoding="utf-8"))
        worker = json.loads(worker_inspect_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ReleaseError(f"invalid image evidence or docker inspect output: {error}") from error
    if not isinstance(evidence, dict) or not isinstance(web, list) or not isinstance(worker, list):
        raise ReleaseError("image evidence and inspect results have invalid shapes")
    if evidence.get("revision") != revision or evidence.get("migrations_sha256") != migrations_sha256:
        raise ReleaseError("tested image evidence does not match the verified revision and migration hash")
    for name, inspected in (("web", web), ("worker", worker)):
        if len(inspected) != 1 or not isinstance(inspected[0], dict):
            raise ReleaseError(f"docker inspect must return exactly one {name} image")
        item = inspected[0]
        labels = item.get("Config", {}).get("Labels") or {}
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", str(item.get("Id", ""))):
            raise ReleaseError(f"loaded {name} image ID is not a full sha256 digest")
        if item.get("Id") != evidence.get("images", {}).get(name, {}).get("id"):
            raise ReleaseError(f"loaded {name} image ID differs from the tested image ID")
        if item.get("Os") != "linux" or item.get("Architecture") != "amd64":
            raise ReleaseError(f"loaded {name} image must be linux/amd64")
        if labels.get(LABEL_REVISION) != revision:
            raise ReleaseError(f"loaded {name} image revision label does not match")
        if labels.get(LABEL_MIGRATIONS) != migrations_sha256:
            raise ReleaseError(f"loaded {name} image migration label does not match")


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    event = commands.add_parser("event-check")
    event.add_argument("--event-name", required=True)
    event.add_argument("--ref", required=True)
    event.add_argument("--sha", required=True)
    event.add_argument("--event-path", required=True, type=Path)
    event.add_argument("--output", type=Path)

    migrations = commands.add_parser("migration-hash")
    migrations.add_argument("--root", type=Path, default=Path.cwd())

    namespace = commands.add_parser("validate-namespace")
    namespace.add_argument("value")

    missing = commands.add_parser("verify-missing-manifest")
    missing.add_argument("reference")

    evidence = commands.add_parser("verify-loaded-images")
    evidence.add_argument("--evidence", required=True, type=Path)
    evidence.add_argument("--web-inspect", required=True, type=Path)
    evidence.add_argument("--worker-inspect", required=True, type=Path)
    evidence.add_argument("--revision", required=True)
    evidence.add_argument("--migrations-sha256", required=True)

    record = commands.add_parser("record-images")
    record.add_argument("--revision", required=True)
    record.add_argument("--migrations-sha256", required=True)
    record.add_argument("--web-id", required=True)
    record.add_argument("--worker-id", required=True)
    record.add_argument("--output", required=True, type=Path)

    manifest = commands.add_parser("manifest")
    manifest.add_argument("--namespace", required=True)
    manifest.add_argument("--revision", required=True)
    manifest.add_argument("--version", required=True)
    manifest.add_argument("--migrations-sha256", required=True)
    manifest.add_argument("--web-digest", required=True)
    manifest.add_argument("--worker-digest", required=True)
    manifest.add_argument("--output", required=True, type=Path)

    args = parser.parse_args()
    try:
        if args.command == "event-check":
            result = event_check(args.event_name, args.ref, args.sha, args.event_path)
            if args.output:
                with args.output.open("a", encoding="utf-8") as stream:
                    for key, value in result.items():
                        stream.write(f"{key}={value}\n")
            print(json.dumps(result, sort_keys=True))
        elif args.command == "migration-hash":
            print(migration_fingerprint(args.root))
        elif args.command == "validate-namespace":
            print(validate_namespace(args.value))
        elif args.command == "verify-missing-manifest":
            verify_missing_manifest(args.reference, sys.stdin.read())
        elif args.command == "verify-loaded-images":
            verify_loaded_images(
                args.evidence, args.web_inspect, args.worker_inspect,
                revision=args.revision, migrations_sha256=args.migrations_sha256,
            )
        elif args.command == "record-images":
            if not SHA_RE.fullmatch(args.revision) or not re.fullmatch(r"[0-9a-f]{64}", args.migrations_sha256):
                raise ReleaseError("invalid revision or migration fingerprint")
            if not re.fullmatch(r"sha256:[0-9a-f]{64}", args.web_id) or not re.fullmatch(r"sha256:[0-9a-f]{64}", args.worker_id):
                raise ReleaseError("Docker image IDs must be full sha256 digests")
            write_json(args.output, {
                "revision": args.revision,
                "migrations_sha256": args.migrations_sha256,
                "images": {
                    "web": {"id": args.web_id},
                    "worker": {"id": args.worker_id},
                },
            })
        elif args.command == "manifest":
            result = make_manifest(
                namespace=args.namespace,
                revision=args.revision,
                version=args.version,
                migrations_sha256=args.migrations_sha256,
                web_digest=args.web_digest,
                worker_digest=args.worker_digest,
            )
            write_json(args.output, result)
        return 0
    except ReleaseError as error:
        print(f"container release check failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
