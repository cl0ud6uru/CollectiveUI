import { describe, expect, it } from "vitest";
import { accountRejection, decodeJwtPayload, isWorkspacePlan, planLabel, readChatGPTClaims, userMayUseChatGPT } from "@/lib/llm/chatgpt/policy";
import type { ChatGPTSettings } from "@/lib/settings";

const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
const AUTH = "https://api.openai.com/auth";

const settings = (over: Partial<ChatGPTSettings> = {}): ChatGPTSettings => ({
  enabled: true,
  access: "selected",
  allowedGroupIds: [],
  allowedUpns: [],
  allowedWorkspaceIds: [],
  allowPersonalPlans: false,
  allowBackground: false,
  ...over,
});
const person = (over: { upn?: string; groupIds?: string[]; isAdmin?: boolean } = {}) => ({
  user: { upn: over.upn ?? "jane@corp.local" },
  groupIds: over.groupIds ?? [],
  isAdmin: over.isAdmin ?? false,
});

describe("ChatGPT sign-in claims", () => {
  it("reads account facts from the id token, with the access token as fallback", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const claims = readChatGPTClaims({
      idToken: jwt({ email: "jane@example.com", [AUTH]: { chatgpt_account_id: "ws-1", chatgpt_plan_type: "Business", chatgpt_user_id: "user-1" } }),
      accessToken: jwt({ exp, [AUTH]: { chatgpt_account_id: "ws-access", chatgpt_account_is_fedramp: true, chatgpt_data_residency: "eu" } }),
    });
    expect(claims).toEqual({
      accountId: "ws-1",
      planType: "business",
      userId: "user-1",
      email: "jane@example.com",
      isFedramp: true,
      residency: "eu",
      expiresAt: new Date(exp * 1000),
    });
    expect(readChatGPTClaims({ accessToken: jwt({ [AUTH]: { chatgpt_account_id: "ws-access" } }) })?.accountId).toBe("ws-access");
  });

  it("an earlier id token only fills in what the fresh tokens don't say", () => {
    const oldId = jwt({ email: "jane@example.com", [AUTH]: { chatgpt_account_id: "ws-1", chatgpt_plan_type: "plus", chatgpt_account_is_fedramp: true, chatgpt_data_residency: "eu" } });
    const freshAccess = jwt({ [AUTH]: { chatgpt_account_id: "ws-1", chatgpt_plan_type: "pro" } });
    expect(readChatGPTClaims({ accessToken: freshAccess, fallbackIdToken: oldId })).toMatchObject({
      planType: "pro", // the fresh access token wins
      isFedramp: true, // id-token facts are kept
      residency: "eu",
      email: "jane@example.com",
    });
  });

  it("ignores the no_constraint residency and rejects tokens without an account", () => {
    expect(readChatGPTClaims({ accessToken: jwt({ [AUTH]: { chatgpt_account_id: "a", chatgpt_compute_residency: "no_constraint" } }) })?.residency).toBeNull();
    expect(readChatGPTClaims({ accessToken: jwt({ [AUTH]: {} }) })).toBeNull();
    expect(readChatGPTClaims({ accessToken: "not-a-jwt" })).toBeNull();
    expect(decodeJwtPayload("a.%%%.b")).toBeNull();
  });

  it("classifies workspace and personal plans", () => {
    for (const p of ["team", "business", "enterprise", "hc", "edu", "education", "edu_plus", "self_serve_business_usage_based", "enterprise_cbp_automation"]) {
      expect(isWorkspacePlan(p), p).toBe(true);
    }
    for (const p of ["free", "go", "plus", "pro", "prolite", null, "", "mystery"]) expect(isWorkspacePlan(p), String(p)).toBe(false);
    expect(planLabel("plus")).toBe("Plus");
    expect(planLabel("self_serve_business_prolite")).toBe("Business");
    expect(planLabel(null)).toBe("Unknown plan");
  });
});

describe("who may connect which account", () => {
  it("personal plans need allowPersonalPlans; unknown plans count as personal", () => {
    expect(accountRejection({ accountId: "p", planType: "plus" }, settings())).toMatch(/Personal ChatGPT plans \(Plus\)/);
    expect(accountRejection({ accountId: "p", planType: null }, settings())).toMatch(/Personal/);
    expect(accountRejection({ accountId: "p", planType: "plus" }, settings({ allowPersonalPlans: true }))).toBeNull();
  });

  it("workspace plans must be in the allowed list when there is one", () => {
    expect(accountRejection({ accountId: "ws-1", planType: "enterprise" }, settings())).toBeNull();
    expect(accountRejection({ accountId: "ws-1", planType: "enterprise" }, settings({ allowedWorkspaceIds: ["ws-1"] }))).toBeNull();
    expect(accountRejection({ accountId: "ws-2", planType: "enterprise" }, settings({ allowedWorkspaceIds: ["ws-1"] }))).toMatch(/workspace/);
    // The workspace list doesn't apply to personal plans (they're governed by allowPersonalPlans).
    expect(accountRejection({ accountId: "p", planType: "pro" }, settings({ allowedWorkspaceIds: ["ws-1"], allowPersonalPlans: true }))).toBeNull();
  });

  it("access follows the admin settings", () => {
    expect(userMayUseChatGPT(person({ isAdmin: true }), settings({ enabled: false }))).toBe(false);
    expect(userMayUseChatGPT(person(), settings())).toBe(false);
    expect(userMayUseChatGPT(person(), settings({ access: "everyone" }))).toBe(true);
    expect(userMayUseChatGPT(person({ isAdmin: true }), settings())).toBe(true);
    expect(userMayUseChatGPT(person({ groupIds: ["g1"] }), settings({ allowedGroupIds: ["g1"] }))).toBe(true);
    expect(userMayUseChatGPT(person({ groupIds: ["g2"] }), settings({ allowedGroupIds: ["g1"] }))).toBe(false);
    expect(userMayUseChatGPT(person({ upn: "Jane@Corp.Local" }), settings({ allowedUpns: ["jane@corp.local"] }))).toBe(true);
  });
});
