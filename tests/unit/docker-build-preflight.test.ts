import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
function run(script = "docker-build-preflight.sh", args: string[] = [], over: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "collective-build-preflight-")); roots.push(dir);
  const log = path.join(dir, "commands");
  writeFileSync(path.join(dir, "docker"), `#!/bin/bash
printf '%s:' "\${DOCKER_BUILDKIT:-unset}" >> "$COMMAND_LOG"
printf '<%s>' "$@" >> "$COMMAND_LOG"
printf '\\n' >> "$COMMAND_LOG"
if [[ "\${FAIL_AT:-}" == "$1 \${2:-}" ]]; then echo 'synthetic private diagnostic' >&2; exit 1; fi
case "$1 \${2:-}" in
  'buildx inspect') printf 'Driver: docker-container\\nStatus: %s\\n' "\${BUILDER_STATUS:-running}" ;;
  'image inspect') echo 'sha256:synthetic' ;;
esac
`, { mode: 0o700 });
  const result = spawnSync("/bin/bash", [path.resolve("scripts", script), ...args], {
    encoding: "utf8", env: { ...process.env, PATH: `${dir}:/usr/bin:/bin`, COMMAND_LOG: log, DOCKER_BUILDKIT: "", FAIL_AT: "", BUILDER_STATUS: "running", ...over },
  });
  return { ...result, commands: readFileSync(log, { encoding: "utf8", flag: "a+" }) };
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it.each([
  ["info ", "Cannot access the Docker daemon"],
  ["compose version", "Compose v2 is missing"],
  ["buildx version", "Ubuntu docker.io needs docker-buildx"],
  ["buildx inspect", "Cannot inspect the selected BuildKit builder"],
])("fails early for %s with a useful private-diagnostic-free message", (stage, message) => {
  const result = run("build-images.sh", [], { FAIL_AT: stage });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
  expect(result.stderr).not.toContain("synthetic private diagnostic");
  expect(result.commands).not.toContain("<compose><build>");
  expect(result.commands).not.toMatch(/<up>|<run>|<create>|<install>|<pull>|--bootstrap/);
});

it("rejects explicit legacy building and a builder node reporting error", () => {
  const legacy = run("build-images.sh", [], { DOCKER_BUILDKIT: "0" });
  expect(legacy.status).toBe(1); expect(legacy.stderr).toContain("legacy builder");
  expect(legacy.commands).toBe("");
  const unavailable = run("build-images.sh", [], { BUILDER_STATUS: "error" });
  expect(unavailable.status).toBe(1); expect(unavailable.stderr).toContain("unavailable node");
  expect(unavailable.commands).not.toContain("<compose><build>");
});

it("allows a cold builder without bootstrapping, validates quietly, and preserves build argument boundaries", () => {
  const result = run("build-images.sh", ["--build-arg", "VALUE=a b", "web", "worker"], { BUILDER_STATUS: "inactive" });
  expect(result.status).toBe(0);
  expect(result.commands).toContain("<compose><config><--quiet>");
  expect(result.commands).toContain("1:<compose><build><--build-arg><VALUE=a b><web><worker>");
  expect(result.commands).not.toMatch(/<up>|<run>|<create>|<pull>|--bootstrap/);
});

it("stops before building when Compose configuration fails", () => {
  const result = run("build-images.sh", [], { FAIL_AT: "compose config" });
  expect(result.status).toBe(1);
  expect(result.commands).not.toContain("<compose><build>");
});

it("workspace builds use the same preflight without requiring Compose and explicitly use BuildKit", () => {
  const result = run("build-sandbox-image.sh", [], { FAIL_AT: "compose version", SANDBOX_IMAGE: "synthetic:test" });
  expect(result.status).toBe(0);
  expect(result.commands).not.toContain("<compose>");
  expect(result.commands).toContain("1:<build><--tag><synthetic:test><.>");
});

it("rejects unsupported preflight arguments without invoking Docker", () => {
  const result = run("docker-build-preflight.sh", ["--bootstrap"]);
  expect(result.status).toBe(2); expect(result.commands).toBe("");
});
