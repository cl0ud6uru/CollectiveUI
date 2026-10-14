import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const account = readFileSync("src/components/settings/chatgpt-connection.tsx", "utf8");
const legacy = readFileSync("src/components/settings/personal-codex-connection.tsx", "utf8");
const settings = readFileSync("src/components/settings-view.tsx", "utf8");
const page = readFileSync("src/app/(chat)/settings/page.tsx", "utf8");

describe("unified ChatGPT account settings", () => {
  it("always mounts a single API-backed account entry for all account states", () => {
    expect(settings).toContain('<ChatGPTConnection />');
    expect(page).toContain('key={`${p.user.id}:${p.user.sessionVersion}`}');
    expect(settings).not.toContain("chatgpt && <ChatGPTConnection");
    expect(account).toContain('fetch("/api/me/chatgpt"');
    expect(account).toContain('action: "disconnect"');
    expect(account).toContain('action: "sync-token"');
  });

  it("shows actionable fetch failures and distinct enrollment/backend availability", () => {
    expect(account).toContain("Could not load your ChatGPT account");
    expect(account).toContain(">Retry</Button>");
    expect(account).toContain("view.reason");
    expect(account).toContain('["not_connected", "stopped"].includes(view.backends.codex.state)');
    expect(account).toContain("data.revocationConfirmed === false");
    expect(account).toContain("Native CollectiveUI");
    expect(account).toContain("void refresh(true)");
  });

  it("keeps legacy native sign-in limited to cleanup controls", () => {
    expect(account).toContain("<PersonalCodexConnection />");
    expect(legacy).toContain("Remove legacy grant");
    expect(legacy).not.toContain("Connect ChatGPT</Button>");
    expect(legacy).toContain("Retry legacy status");
  });
});
