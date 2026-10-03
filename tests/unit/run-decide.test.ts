import { describe, expect, it } from "vitest";
import { decideFinal, finalErrorText } from "@/lib/runs/decide";
import type { AbortKind } from "@/lib/runs/types";

describe("decideFinal", () => {
  it.each([
    [{ abort: "lease-lost", error: "x", pendingApproval: true }, null],
    [{ abort: "cancel", error: "x", pendingApproval: true }, "cancelled"],
    [{ abort: "shutdown", error: "x", pendingApproval: true }, "interrupted"],
    [{ abort: "timeout", pendingApproval: true }, "failed"],
    [{ error: "The model endpoint returned an error: 500", pendingApproval: true }, "failed"],
    [{ pendingApproval: true }, "waiting"],
    [{ pendingApproval: false }, "succeeded"],
    [{ error: "", pendingApproval: false }, "succeeded"],
  ] as const)("%j → %s", (input, expected) => {
    expect(decideFinal(input as { abort?: AbortKind; error?: string; pendingApproval: boolean })).toBe(expected);
  });
});

describe("finalErrorText", () => {
  const timeoutMs = 30 * 60_000;

  it("says nothing for a stop or a lost lease", () => {
    expect(finalErrorText({ abort: "cancel", error: "aborted", timeoutMs })).toBeNull();
    expect(finalErrorText({ abort: "lease-lost", error: "aborted", timeoutMs })).toBeNull();
    expect(finalErrorText({ timeoutMs })).toBeNull();
  });

  it("explains a restart and a timeout (in minutes)", () => {
    expect(finalErrorText({ abort: "shutdown", timeoutMs })).toBe("The worker restarted while this reply was running. Try again.");
    expect(finalErrorText({ abort: "timeout", error: "aborted", timeoutMs })).toBe("The reply took longer than 30 min and was stopped.");
    expect(finalErrorText({ abort: "timeout", timeoutMs: 10 * 60_000 })).toBe("The reply took longer than 10 min and was stopped.");
    expect(finalErrorText({ abort: "timeout", timeoutMs: 5_000 })).toBe("The reply took longer than 1 min and was stopped.");
  });

  it("passes the (already user-facing) error through, capped", () => {
    expect(finalErrorText({ error: "Connect your ChatGPT plan again.", timeoutMs })).toBe("Connect your ChatGPT plan again.");
    const long = finalErrorText({ error: "x".repeat(2000), timeoutMs })!;
    expect(long).toHaveLength(500);
    expect(long.endsWith("…")).toBe(true);
  });
});
