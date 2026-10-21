import { describe, expect, it } from "vitest";
import type { Principal } from "@/lib/auth/groups";
import { architectCallDenial, isArchitectBot, type ArchitectCallFacts } from "@/lib/bots/architect-policy";

const admin = { user: { id: "u1", sessionVersion: 3 }, isAdmin: true, groupIds: [], canCreateBots: true } as unknown as Principal;
const ok: ArchitectCallFacts = {
  fresh: admin,
  sessionVersion: 3,
  receiptBotId: "arch",
  bot: { id: "arch", enabled: true, executionMode: "caller", hermesTeam: false },
  ctx: { depth: 0, background: false },
};
const deny = (patch: Partial<ArchitectCallFacts>) => architectCallDenial({ ...ok, ...patch });

describe("Architect admin tool call policy", () => {
  it("allows a current admin in a direct chat with the installed Architect", () => {
    expect(architectCallDenial(ok)).toBeNull();
  });

  it("refuses deleted or disabled accounts, demoted admins and stale sessions", () => {
    expect(deny({ fresh: null })).toMatch(/unavailable/);
    expect(deny({ fresh: { ...admin, isAdmin: false } })).toMatch(/administrators only/);
    expect(deny({ sessionVersion: 2 })).toMatch(/session changed/);
  });

  it("refuses any bot other than the installed, enabled caller Architect", () => {
    expect(deny({ receiptBotId: null })).toMatch(/only in The Architect/);
    expect(deny({ receiptBotId: "other" })).toMatch(/only in The Architect/);
    expect(deny({ bot: null })).toMatch(/only in The Architect/);
    expect(deny({ bot: { ...ok.bot!, enabled: false } })).toMatch(/disabled/);
    expect(deny({ bot: { ...ok.bot!, executionMode: "service" } })).toMatch(/caller bot/);
    expect(deny({ bot: { ...ok.bot!, hermesTeam: true } })).toMatch(/caller bot/);
  });

  it("refuses delegated, group and unattended turns", () => {
    expect(deny({ ctx: { ...ok.ctx, depth: 1 } })).toMatch(/delegation/);
    expect(deny({ ctx: { ...ok.ctx, taskId: "t1" } })).toMatch(/delegation/);
    expect(deny({ ctx: { ...ok.ctx, delegationPath: [{} as never] } })).toMatch(/delegation/);
    expect(deny({ ctx: { ...ok.ctx, inGroup: true } })).toMatch(/group chats/);
    expect(deny({ ctx: { ...ok.ctx, background: true } })).toMatch(/unattended/);
  });

  it("identifies the Architect only by a non-empty matching receipt", () => {
    expect(isArchitectBot({ id: "arch" }, "arch")).toBe(true);
    expect(isArchitectBot({ id: "arch" }, null)).toBe(false);
    expect(isArchitectBot({ id: "" }, "")).toBe(false);
    expect(isArchitectBot(null, "arch")).toBe(false);
  });
});
