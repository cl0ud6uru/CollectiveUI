import { describe, expect, it } from "vitest";
import { createTeamResourceSnapshot, resourceSha256, type TeamResource } from "@/lib/hermes-team/resources";
import {
  beginResourceUpdate, EMPTY_RESOURCE_GROUP_HASH, nextResourceUpdateStep,
  planTeamResourceUpdate, recordResourceUpdateApplied, resourceGroupHash, resourceRolloutSummary,
} from "@/lib/hermes-team/updates";

const skill = (name: string, content: string, file = "SKILL.md"): TeamResource => ({
  path: `skills/${name}/${file}`, kind: "skill", packageId: `skills/${name}`,
  sha256: resourceSha256(content), encoding: "utf8", content, size: Buffer.byteLength(content),
});
const snapshot = (...resources: TeamResource[]) => createTeamResourceSnapshot(resources);
const memberSnapshot = (...resources: TeamResource[]) => createTeamResourceSnapshot(resources, { requireCompleteSkills: false });
const empty = snapshot();
const actionFor = (plan: ReturnType<typeof planTeamResourceUpdate>, id: string) => plan.actions.find(action => action.packageId === "skills/" + id)!;

describe("Hermes team resource reconciliation", () => {
  it("updates and removes only unchanged team-owned packages, including scripts/assets", () => {
    const first = snapshot(skill("support", "v1"), skill("support", "old script", "scripts/run.py"), skill("obsolete", "v1"));
    const next = snapshot(skill("support", "v2"), skill("support", "asset", "assets/help.txt"));
    const plan = planTeamResourceUpdate({ installed: first, release: next, current: first });
    expect(actionFor(plan, "support")).toMatchObject({ action: "install", removePaths: ["skills/support/scripts/run.py"], writeResources: next.resources });
    expect(actionFor(plan, "obsolete")).toMatchObject({ action: "remove", removePaths: ["skills/obsolete/SKILL.md"] });
    expect(Object.isFrozen(plan.actions)).toBe(true); expect(resourceRolloutSummary(plan)).toEqual({ pendingGroups: 2, conflictGroups: 0, preservedGroups: 0, deletedGroups: 0 });
  });
  it("preserves modified, independently learned and member-deleted packages", () => {
    const first = snapshot(skill("modified", "v1"), skill("deleted", "v1"), skill("removed", "v1"));
    const next = snapshot(skill("modified", "v2"), skill("deleted", "v2"));
    const current = snapshot(skill("modified", "member correction"), skill("removed", "member correction"), skill("learned", "native learning"));
    const plan = planTeamResourceUpdate({ installed: first, release: next, current });
    expect(actionFor(plan, "modified")).toMatchObject({ action: "conflict", reason: "member-modified", writeResources: [], removePaths: [] });
    expect(actionFor(plan, "removed")).toMatchObject({ action: "conflict", reason: "member-modified", teamResources: [] });
    expect(actionFor(plan, "deleted")).toMatchObject({ action: "preserve", reason: "member-deleted" });
    expect(actionFor(plan, "learned")).toMatchObject({ action: "preserve", reason: "independent-learning" });
    expect(plan.overrides).toEqual({ "skills/deleted": "deleted" });
    const later = planTeamResourceUpdate({ installed: next, release: snapshot(skill("deleted", "v3")), current, overrides: plan.overrides });
    expect(actionFor(later, "deleted")).toMatchObject({ action: "preserve", reason: "member-deleted" });
  });
  it("treats a member-added asset or partial file deletion as a whole-package conflict", () => {
    const first = snapshot(skill("support", "v1"), skill("support", "v1 script", "scripts/run.py"));
    const next = snapshot(skill("support", "v2"), skill("support", "v2 script", "scripts/run.py"));
    const added = snapshot(...first.resources, skill("support", "new native asset", "assets/member.txt"));
    expect(actionFor(planTeamResourceUpdate({ installed: first, release: next, current: added }), "support").action).toBe("conflict");
    const partiallyDeleted = memberSnapshot(skill("support", "v1 script", "scripts/run.py"));
    expect(actionFor(planTeamResourceUpdate({ installed: first, release: next, current: partiallyDeleted }), "support").action).toBe("conflict");
  });
  it("does not overwrite a learned package colliding with a first team release", () => {
    const plan = planTeamResourceUpdate({ installed: empty, release: snapshot(skill("support", "team")), current: snapshot(skill("support", "member")) });
    expect(actionFor(plan, "support")).toMatchObject({ action: "conflict", reason: "learned-collision" });
  });
  it("uses the exact private/team preview hashes to resolve conflicts and persists Keep my version", () => {
    const first = snapshot(skill("support", "v1")), next = snapshot(skill("support", "v2")), current = snapshot(skill("support", "member"));
    const conflict = actionFor(planTeamResourceUpdate({ installed: first, release: next, current }), "support");
    const resolution = { packageId: conflict.packageId, expectedMemberHash: conflict.beforeHash, expectedTeamHash: conflict.teamHash };
    const keep = planTeamResourceUpdate({ installed: first, release: next, current, resolutions: [{ ...resolution, choice: "keep-member" }] });
    expect(actionFor(keep, "support")).toMatchObject({ action: "preserve", reason: "member-override" });
    expect(keep.overrides).toEqual({ "skills/support": "keep-member" });
    const future = planTeamResourceUpdate({ installed: next, release: snapshot(skill("support", "v3")), current, overrides: keep.overrides });
    expect(actionFor(future, "support").action).toBe("preserve");
    const use = planTeamResourceUpdate({ installed: first, release: next, current, resolutions: [{ ...resolution, choice: "use-team" }] });
    expect(actionFor(use, "support")).toMatchObject({ action: "install", writeResources: next.resources });
    expect(use.overrides).toEqual({});
    expect(() => planTeamResourceUpdate({ installed: first, release: next, current: snapshot(skill("support", "new correction")), resolutions: [{ ...resolution, choice: "use-team" }] })).toThrow("stale");
    expect(() => planTeamResourceUpdate({ installed: first, release: next, current, resolutions: [{ ...resolution, choice: "use-team", expectedTeamHash: "stale" }] })).toThrow("stale");
  });
  it("preserves deletion across a team removal/reintroduction unless explicitly reset", () => {
    const first = snapshot(skill("support", "v1"));
    const removed = planTeamResourceUpdate({ installed: first, release: empty, current: empty });
    const next = snapshot(skill("support", "v2"));
    const plan = planTeamResourceUpdate({ installed: empty, release: next, current: empty, overrides: removed.overrides });
    const action = actionFor(plan, "support"); expect(action.action).toBe("preserve");
    const reset = planTeamResourceUpdate({ installed: empty, release: next, current: empty, overrides: removed.overrides,
      resolutions: [{ packageId: action.packageId, choice: "use-team", expectedMemberHash: action.beforeHash, expectedTeamHash: action.teamHash }] });
    expect(actionFor(reset, "support").action).toBe("install"); expect(reset.overrides).toEqual({});
  });
  it("rolls back with the same rules and preserves personal learning", () => {
    const old = snapshot(skill("support", "v1")), installed = snapshot(skill("support", "v2"));
    expect(actionFor(planTeamResourceUpdate({ installed, release: old, current: installed }), "support").writeResources).toEqual(old.resources);
    const current = snapshot(skill("support", "member improvement"), skill("learned", "new native skill"));
    const rollback = planTeamResourceUpdate({ installed, release: old, current });
    expect(actionFor(rollback, "support").action).toBe("conflict"); expect(actionFor(rollback, "learned").reason).toBe("independent-learning");
  });
  it("is deterministic and admin rollout status contains no private skills or hashes", () => {
    const first = snapshot(skill("support", "v1")), next = snapshot(skill("support", "v2")), current = snapshot(skill("support", "private correction"));
    const plan = planTeamResourceUpdate({ installed: first, release: next, current });
    expect(planTeamResourceUpdate({ installed: first, release: next, current })).toEqual(plan);
    expect(JSON.stringify(resourceRolloutSummary(plan))).not.toContain("private"); expect(JSON.stringify(resourceRolloutSummary(plan))).not.toContain(actionFor(plan, "support").beforeHash);
  });
  it("rejects unknown, duplicate and unsafe resolutions", () => {
    const resolution = { packageId: "skills/support", choice: "use-team" as const, expectedMemberHash: EMPTY_RESOURCE_GROUP_HASH, expectedTeamHash: EMPTY_RESOURCE_GROUP_HASH };
    expect(() => planTeamResourceUpdate({ installed: empty, release: empty, current: empty, resolutions: [resolution] })).toThrow("unknown");
    expect(() => planTeamResourceUpdate({ installed: empty, release: snapshot(skill("support", "v1")), current: empty, resolutions: [resolution, resolution] })).toThrow("duplicate");
    expect(() => planTeamResourceUpdate({ installed: empty, release: empty, current: empty, overrides: { "../auth.json": "deleted" } })).toThrow();
  });
});

describe("Hermes resource update receipts and crash recovery", () => {
  const first = snapshot(skill("a", "a1"), skill("b", "b1"));
  const release = snapshot(skill("a", "a2"), skill("b", "b2"));
  const plan = planTeamResourceUpdate({ installed: first, release, current: first });
  it("preserves plan hashes when JSONB reorders every persisted object key", () => {
    const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reorder(child)])) : value;
    const withOverrides = planTeamResourceUpdate({ installed: first, release, current: first, overrides: { "skills/deleted-long-name": "deleted", "skills/c": "keep-member" } });
    const persisted = reorder(withOverrides) as typeof withOverrides;
    expect(beginResourceUpdate("jsonb-order", persisted)).toEqual(beginResourceUpdate("jsonb-order", withOverrides));
  });
  it("handles double-clicks, JSON persistence, sequential completion and completed retries", () => {
    const started = beginResourceUpdate("operation-1", plan);
    expect(beginResourceUpdate("operation-1", plan, JSON.parse(JSON.stringify(started)))).toEqual(started);
    const a = actionFor(plan, "a"), b = actionFor(plan, "b");
    const live = new Map([[a.packageId, a.beforeHash], [b.packageId, b.beforeHash]]);
    const step = nextResourceUpdateStep(plan, started, id => live.get(id)!); expect(step.kind).toBe("apply");
    expect(() => recordResourceUpdateApplied(plan, started, b.packageId, b.afterHash)).toThrow("in order");
    live.set(a.packageId, a.afterHash);
    const afterA = recordResourceUpdateApplied(plan, started, a.packageId, a.afterHash);
    expect(recordResourceUpdateApplied(plan, afterA, a.packageId, a.afterHash)).toEqual(afterA);
    expect(nextResourceUpdateStep(plan, afterA, id => live.get(id)!)).toMatchObject({ kind: "apply", action: { packageId: b.packageId } });
    live.set(b.packageId, b.afterHash);
    const afterB = recordResourceUpdateApplied(plan, afterA, b.packageId, b.afterHash);
    const done = nextResourceUpdateStep(plan, afterB, id => live.get(id)!);
    expect(done).toMatchObject({ kind: "complete", installedManifestHash: release.manifestHash, receipt: { status: "complete" } });
    expect(nextResourceUpdateStep(plan, done.receipt, () => { throw new Error("completed groups must not write again"); })).toEqual(done);
  });
  it("recovers a crash after atomic group replacement before the receipt was recorded", () => {
    const started = beginResourceUpdate("crash-1", plan), a = actionFor(plan, "a"), b = actionFor(plan, "b");
    const step = nextResourceUpdateStep(plan, started, id => id === a.packageId ? a.afterHash : b.beforeHash);
    expect(step).toMatchObject({ kind: "apply", receipt: { completedGroups: [a.packageId] }, action: { packageId: b.packageId } });
    const done = nextResourceUpdateStep(plan, started, id => id === a.packageId ? a.afterHash : b.afterHash);
    expect(done).toMatchObject({ kind: "complete", receipt: { completedGroups: [a.packageId, b.packageId] } });
  });
  it("blocks partial writes or new learning instead of replaying over them", () => {
    const started = beginResourceUpdate("crash-2", plan);
    const broken = nextResourceUpdateStep(plan, started, () => resourceGroupHash([skill("a", "partial or new native writes")]));
    expect(broken).toMatchObject({ kind: "blocked", receipt: { status: "needs-attention" }, packageId: "skills/a" });
    expect(nextResourceUpdateStep(plan, broken.receipt, () => actionFor(plan, "a").beforeHash)).toEqual(broken);
    expect(() => recordResourceUpdateApplied(plan, started, "skills/a", "partial")).toThrow("as reviewed");
  });
  it("rejects reused IDs for different plans and tampered persisted plans or receipts", () => {
    const started = beginResourceUpdate("same-id", plan);
    const other = planTeamResourceUpdate({ installed: first, release: snapshot(skill("a", "a3")), current: first });
    expect(() => beginResourceUpdate("same-id", other, started)).toThrow("receipt");
    expect(() => beginResourceUpdate("different-id", plan, started)).toThrow("mismatch");
    expect(() => beginResourceUpdate("../auth", plan)).toThrow("operation ID");
    const tampered = JSON.parse(JSON.stringify(plan)); tampered.actions[0].writeResources[0].content = "unreviewed";
    expect(() => beginResourceUpdate("tampered", tampered)).toThrow("changed after review");
    expect(() => beginResourceUpdate("same-id", plan, { ...started, completedGroups: ["unknown"] })).toThrow("receipt");
  });
  it("completes without writes when preserving member learning or deletions", () => {
    const conflict = planTeamResourceUpdate({ installed: first, release, current: snapshot(skill("a", "member")) });
    const done = nextResourceUpdateStep(conflict, beginResourceUpdate("preserved", conflict), () => { throw new Error("no writes expected"); });
    expect(done).toMatchObject({ kind: "complete", overrides: { "skills/b": "deleted" } });
    expect(resourceRolloutSummary(conflict).conflictGroups).toBe(1);
  });
});


describe("Cross-revision resource package boundaries", () => {
  it("rejects moving a nested child out of a preserved modified parent package", () => {
    const installed = snapshot(skill("parent", "parent"), skill("parent", "child original", "child/SKILL.md"));
    const current = snapshot(skill("parent", "parent"), skill("parent", "member improved child", "child/SKILL.md"));
    const release = snapshot(skill("parent/child", "team child"));
    expect(() => planTeamResourceUpdate({ installed, release, current })).toThrow("boundaries overlap");
  });
  it("rejects moving a child package into a preserved member-modified ancestor", () => {
    const installed = snapshot(skill("parent/child", "child original"));
    const current = snapshot(skill("parent/child", "member improved child"));
    const release = snapshot(skill("parent", "team parent"), skill("parent", "team child", "child/SKILL.md"));
    expect(() => planTeamResourceUpdate({ installed, release, current })).toThrow("boundaries overlap");
  });
  it("rejects a new team ancestor overlapping an independently learned member child", () => {
    expect(() => planTeamResourceUpdate({ installed: empty, release: snapshot(skill("parent", "team")), current: snapshot(skill("parent/child", "member")) })).toThrow("boundaries overlap");
  });
});


describe("Deleted package boundary preservation", () => {
  it("rejects a new team child/ancestor that overlaps a durable deleted-package choice", () => {
    expect(() => planTeamResourceUpdate({ installed: empty, release: snapshot(skill("parent/child", "new team child")), current: empty,
      overrides: { "skills/parent": "deleted" } })).toThrow("boundaries overlap");
    expect(() => planTeamResourceUpdate({ installed: empty, release: snapshot(skill("parent", "new team parent")), current: empty,
      overrides: { "skills/parent/child": "deleted" } })).toThrow("boundaries overlap");
  });
});
