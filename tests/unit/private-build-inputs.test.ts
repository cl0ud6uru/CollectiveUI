import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("private operator files", () => {
  it("keeps database backups and deployment notes out of git without local-only excludes", () => {
    const paths = ["backups/production.sql", "backups/nested/restore.dump", "DEPLOY-NOTES.txt", "docker-compose.override.yml", "certs/internal-ca.crt"];
    // The Docker test image deliberately has no .git directory. Use only the checked-in rules in a disposable
    // repository, so the test also cannot pass accidentally because of a developer's local/global excludes.
    const directory = mkdtempSync(path.join(tmpdir(), "collective-ignore-"));
    try {
      execFileSync("git", ["init", "--quiet", "--template=", directory]);
      writeFileSync(path.join(directory, ".gitignore"), readFileSync(".gitignore", "utf8"));
      const ignored = execFileSync("git", ["-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "--stdin"], {
        cwd: directory, input: paths.join("\n"), encoding: "utf8",
      }).trim().split("\n");
      expect(ignored).toEqual(paths);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("excludes private files before Docker COPY can put them in build-stage layers", () => {
    const patterns = readFileSync(".dockerignore", "utf8").split(/\r?\n/).map(line => line.trim());
    for (const name of ["backups", "DEPLOY-NOTES.txt", "certs", "docker-compose.override.yml", ".env*"])
      expect(patterns).toContain(name);
    expect(patterns).toContain("!.env.example");
  });
});
