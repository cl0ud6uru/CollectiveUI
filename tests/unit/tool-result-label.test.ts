import { describe, expect, it } from "vitest";
import { toolDoneLabel } from "@/components/chat/tool-result-label";

describe("tool completion labels", () => {
  it("reports a forget no-op as unchanged", () => {
    expect(toolDoneLabel("forget", { deleted: false }, "Memory updated")).toBe("Memory unchanged");
  });

  it("keeps the success label when a saved memory was deleted", () => {
    expect(toolDoneLabel("forget", { deleted: true }, "Memory updated")).toBe("Memory updated");
  });

  it("preserves unrelated tool labels and incomplete forget results", () => {
    expect(toolDoneLabel("remember", { saved: true }, "Memory updated")).toBe("Memory updated");
    expect(toolDoneLabel("forget", undefined, "Memory updated")).toBe("Memory updated");
  });
});
