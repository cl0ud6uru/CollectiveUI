import { describe, expect, it } from "vitest";
import { auditActorLabel } from "@/lib/audit-view";

describe("audit actor label", () => {
  it("shows the admin and the agent they acted through", () => {
    expect(auditActorLabel("Ada", { via: { agent: "architect", botId: "b1" }, outcome: "ok" })).toBe("Ada via The Architect");
    expect(auditActorLabel(null, { via: { agent: "architect" } })).toBe("(deleted user) via The Architect");
  });

  it("shows only the person for ordinary entries and malformed details", () => {
    expect(auditActorLabel("Ada", { botId: "b1" })).toBe("Ada");
    expect(auditActorLabel("Ada", null)).toBe("Ada");
    expect(auditActorLabel("Ada", { via: "architect" })).toBe("Ada");
    expect(auditActorLabel("Ada", { via: { agent: 3 } })).toBe("Ada");
  });
});
