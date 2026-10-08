import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("checks persistent original files, ownership, limits, integrity, and installer guards without a live Hermes service", async () => {
  const result = await promisify(execFile)("/usr/bin/python3", ["-B", "tests/fixtures/hermes-attachments.py"], { timeout: 10000, maxBuffer: 128 * 1024 });
  expect(result.stderr).toContain("OK");
});
