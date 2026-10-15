import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const account = readFileSync("src/components/settings/chatgpt-connection.tsx", "utf8");
const device = readFileSync("src/components/settings/personal-codex-connection.tsx", "utf8");
const settings = readFileSync("src/components/settings-view.tsx", "utf8");
const page = readFileSync("src/app/(chat)/settings/page.tsx", "utf8");

describe("unified ChatGPT account settings", () => {
  it("always mounts a single API-backed account entry for all account states", () => {
    expect(settings).toContain('<ChatGPTConnection />');
    expect(page).toContain('key={`${p.user.id}:${p.user.sessionVersion}`}');
    expect(settings).not.toContain("chatgpt && <ChatGPTConnection");
    expect(account).toContain('fetch("/api/me/chatgpt"');
    expect(account).toContain('action: "disconnect-native"');
    expect(account).not.toContain('action: "sync-token"');
  });

  it("shows actionable fetch failures and distinct enrollment/backend availability", () => {
    expect(account).toContain("Could not load your ChatGPT account");
    expect(account).toContain(">Retry</Button>");
    expect(account).toContain("view.reason");
    expect(account).toContain('<PersonalCodexConnection setup={view?.deviceSetup} />');
    expect(device).toContain('setup.runtime.reason');
    expect(account).toContain("data.revocationConfirmed === false");
    expect(account).toContain("Native CollectiveUI");
    expect(account).toContain("void refresh(true)");
  });

  it("offers browser device sign-in independently of the native companion", () => {
    expect(device).toContain("https://auth.openai.com/codex/device");
    expect(device).toContain("Connect stock Codex");
    expect(device).toContain("Confirm stock Codex account");
    expect(device).toContain("Cancel Codex sign-in");
    expect(device).toContain("Disconnect stock Codex");
    expect(device).toContain("Retry Codex status");
    expect(device).not.toContain("collectiveui-chatgpt:");
    expect(account).toContain("Each connection has its own sign-in and status.");
  });
});
