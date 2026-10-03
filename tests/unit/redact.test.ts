import { describe, expect, it } from "vitest";
import { redactSecrets } from "@/lib/redact";
import { vendorEnvPresent } from "@/lib/env-guard";

describe("redactSecrets", () => {
  it.each([
    ["sk-proj-" + "a".repeat(40)],
    ["sk-" + "b".repeat(48)],
    ["sk-ant-api03-" + "c".repeat(40)],
    ["sk-ant-oat01-" + "d".repeat(40)],
    ["at-" + "e".repeat(30)],
    ["ptl_run_" + "f".repeat(30)],
    ["ghp_" + "g".repeat(36)],
    ["AKIAABCDEFGHIJKLMNOP"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVl"],
  ])("masks %s", (secret) => {
    const out = redactSecrets(`failed with ${secret} in the request`);
    expect(out).not.toContain(secret);
    expect(out).toContain("[redacted]");
  });

  it("masks bearer tokens but keeps the scheme", () => {
    expect(redactSecrets("Authorization: Bearer abc.def-123456")).toBe("Authorization: Bearer [redacted]");
  });

  it("leaves ordinary text alone", () => {
    const text = "Task-list at the desk: ask about skills and the sk- prefix";
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("vendor env guard", () => {
  it("lists vendor fallback variables that are set", () => {
    expect(vendorEnvPresent({ OPENAI_API_KEY: "x", PATH: "/bin", ANTHROPIC_API_KEY: "" })).toEqual(["OPENAI_API_KEY"]);
  });
});
