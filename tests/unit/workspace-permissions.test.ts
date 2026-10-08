import { describe, expect, it } from "vitest";
import { normalizeWorkspaceConfig } from "@/lib/bots/tool-config";

describe("workspace permission persistence", () => {
  it("preserves explicit auto and ask permissions while dropping unrelated config", () => {
    expect(normalizeWorkspaceConfig({ tools: ["workspace_bash"], approvals: {
      workspace_bash: "auto", workspace_write: "ask", workspace_read: "auto", workspace_import_attachment: "auto",
      workspace_edit: "smart", send_mail: "auto",
    } })).toEqual({ approvals: { workspace_bash: "auto", workspace_write: "ask", workspace_read: "auto", workspace_import_attachment: "auto" } });
  });

  it("keeps legacy bots without overrides on their existing policy", () => {
    expect(normalizeWorkspaceConfig(null)).toBeNull();
    expect(normalizeWorkspaceConfig({})).toBeNull();
    expect(normalizeWorkspaceConfig({ approvals: { send_mail: "auto" } })).toBeNull();
  });
});
