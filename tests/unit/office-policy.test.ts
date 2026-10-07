import { describe, expect, it } from "vitest";
import type { AiApp } from "@/db/schema";
import { officeModelEligible } from "@/lib/bots/office-policy";

const app = { enabled: true, isPublic: true, kind: "model", supportsTools: true, credentialMode: "org", provider: "openai", providerConfig: {} } as AiApp;
describe("Office Bot model eligibility", () => {
  it("accepts a public company model with native tools", () => expect(officeModelEligible(app)).toBe(true));
  it("rejects runtime, personal-account, and Hermes models", () => {
    for (const patch of [{ kind: "runtime" }, { credentialMode: "user" }, { credentialMode: "user_or_org" }, { provider: "hermes" }, { providerConfig: { docker: {} } }, { providerConfig: { local: {} } }])
      expect(officeModelEligible({ ...app, ...patch } as AiApp)).toBe(false);
  });
});
