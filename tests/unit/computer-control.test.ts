import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("computer desktop control contract", () => {
  it("validates bounded input and safely pauses/resumes a synthetic app-server process tree", () => {
    const output = execFileSync("python3", ["tests/unit/computer_control_test.py"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", NODE_ENV: "test" },
    });
    expect(output).toContain("OK");
  });
});
