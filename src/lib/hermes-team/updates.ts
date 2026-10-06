import {
  assertCompatibleResourcePackageIds, assertCompatibleResourcePackages, assertSafeResourcePath, resourcePackageHash, resourceSha256, validateTeamResourceSnapshot,
  type TeamResource, type TeamResourceSnapshot,
} from "./resources";

export type MemberResourceOverride = "keep-member" | "deleted";
export type ResourceOverrides = Readonly<Record<string, MemberResourceOverride>>;
export interface ResourceConflictResolution {
  packageId: string;
  choice: "keep-member" | "use-team";
  /** Both preview hashes must still match; stale screens cannot overwrite newer learning. */
  expectedMemberHash: string;
  expectedTeamHash: string;
}
export type ResourceUpdateReason = "team-changed" | "team-removed" | "unchanged" | "member-modified" | "member-deleted" | "member-override" | "independent-learning" | "learned-collision";
export interface ResourceUpdateAction {
  readonly packageId: string;
  readonly action: "install" | "remove" | "preserve" | "conflict";
  readonly reason: ResourceUpdateReason;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly teamHash: string;
  /** Private preview: must never be included in an admin rollout response. */
  readonly memberResources: readonly TeamResource[];
  readonly teamResources: readonly TeamResource[];
  readonly writeResources: readonly TeamResource[];
  readonly removePaths: readonly string[];
}
export interface TeamResourceUpdatePlan {
  readonly format: 1;
  readonly planHash: string;
  readonly fromManifestHash: string;
  readonly toManifestHash: string;
  readonly currentManifestHash: string;
  readonly actions: readonly ResourceUpdateAction[];
  readonly overrides: ResourceOverrides;
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const resourceGroupHash = resourcePackageHash;
const EMPTY_HASH = resourceGroupHash([]);
function groups(snapshot: TeamResourceSnapshot): Map<string, readonly TeamResource[]> {
  const result = new Map<string, TeamResource[]>();
  for (const resource of snapshot.resources) result.set(resource.packageId, [...result.get(resource.packageId) ?? [], resource]);
  return result;
}
function assertGroupId(group: string): void {
  assertSafeResourcePath(group);
  if (group !== "SOUL.md" && !group.startsWith("skills/") && !group.startsWith("documents/")) throw new Error("Invalid resource group");
}
function planDigest(plan: Omit<TeamResourceUpdatePlan, "planHash">): string {
  return resourceSha256(JSON.stringify({ format: plan.format, fromManifestHash: plan.fromManifestHash, toManifestHash: plan.toManifestHash, currentManifestHash: plan.currentManifestHash,
    actions: plan.actions.map(action => ({ packageId: action.packageId, action: action.action, reason: action.reason, beforeHash: action.beforeHash, afterHash: action.afterHash, teamHash: action.teamHash,
      memberResources: action.memberResources, teamResources: action.teamResources, writeResources: action.writeResources, removePaths: action.removePaths })), overrides: plan.overrides }));
}
/**
 * Whole-package three-way reconciliation. `installed` is the last offered team revision;
 * `current` must include member files added inside tracked packages as well as learned packages.
 * Persist returned overrides with the installed revision only once application is complete.
 */
export function planTeamResourceUpdate(input: {
  installed: TeamResourceSnapshot;
  release: TeamResourceSnapshot;
  current: TeamResourceSnapshot;
  overrides?: ResourceOverrides;
  resolutions?: readonly ResourceConflictResolution[];
}): TeamResourceUpdatePlan {
  const installed = validateTeamResourceSnapshot(input.installed);
  const release = validateTeamResourceSnapshot(input.release);
  const current = validateTeamResourceSnapshot(input.current, { requireCompleteSkills: false });
  assertCompatibleResourcePackages(installed, release, current);
  const previousGroups = groups(installed), teamGroups = groups(release), memberGroups = groups(current);
  const overrides: Record<string, MemberResourceOverride> = Object.create(null);
  for (const [id, value] of Object.entries(input.overrides ?? {}).sort(([a], [b]) => compare(a, b))) {
    assertGroupId(id);
    if (value !== "keep-member" && value !== "deleted") throw new Error("Invalid member resource override");
    overrides[id] = value;
  }
  const resolutions = new Map<string, ResourceConflictResolution>();
  for (const resolution of input.resolutions ?? []) {
    assertGroupId(resolution.packageId);
    if (resolutions.has(resolution.packageId) || !["keep-member", "use-team"].includes(resolution.choice)) throw new Error("Invalid or duplicate conflict resolution");
    resolutions.set(resolution.packageId, resolution);
  }
  const ids = [...new Set([...previousGroups.keys(), ...teamGroups.keys(), ...memberGroups.keys(), ...Object.keys(overrides)])].sort(compare);
  assertCompatibleResourcePackageIds(ids);
  for (const id of resolutions.keys()) if (!ids.includes(id)) throw new Error("Conflict resolution references an unknown resource group");
  const actions: ResourceUpdateAction[] = [];
  for (const packageId of ids) {
    const previous = previousGroups.get(packageId) ?? [], team = teamGroups.get(packageId) ?? [], member = memberGroups.get(packageId) ?? [];
    const previousHash = resourceGroupHash(previous), teamHash = resourceGroupHash(team), beforeHash = resourceGroupHash(member);
    let action: ResourceUpdateAction["action"], reason: ResourceUpdateReason;
    const resolution = resolutions.get(packageId);
    if (resolution) {
      if (resolution.expectedMemberHash !== beforeHash || resolution.expectedTeamHash !== teamHash) throw new Error("Resource conflict preview is stale; review current versions again");
      if (resolution.choice === "use-team") { action = team.length ? "install" : "remove"; reason = team.length ? "team-changed" : "team-removed"; delete overrides[packageId]; }
      else { action = "preserve"; reason = member.length ? "member-override" : "member-deleted"; overrides[packageId] = member.length ? "keep-member" : "deleted"; }
    } else if (overrides[packageId]) {
      action = "preserve"; reason = overrides[packageId] === "deleted" && !member.length ? "member-deleted" : "member-override";
    } else if (!previous.length && !team.length) {
      action = "preserve"; reason = "independent-learning";
    } else if (previous.length && !member.length) {
      action = "preserve"; reason = "member-deleted"; overrides[packageId] = "deleted";
    } else if (beforeHash === teamHash) {
      action = "preserve"; reason = "unchanged";
    } else if (beforeHash === previousHash) {
      action = team.length ? "install" : "remove"; reason = team.length ? "team-changed" : "team-removed";
    } else if (teamHash === previousHash) {
      action = "preserve"; reason = "member-modified";
    } else {
      action = "conflict"; reason = previous.length ? "member-modified" : "learned-collision";
    }
    const apply = action === "install" || action === "remove";
    const targetPaths = new Set(team.map(resource => resource.path));
    actions.push(Object.freeze({ packageId, action, reason, beforeHash, afterHash: apply ? teamHash : beforeHash, teamHash,
      memberResources: Object.freeze([...member]), teamResources: Object.freeze([...team]),
      writeResources: Object.freeze(apply ? [...team] : []), removePaths: Object.freeze(apply ? member.filter(resource => !targetPaths.has(resource.path)).map(resource => resource.path) : []) }));
  }
  const orderedOverrides = Object.fromEntries(Object.entries(overrides).sort(([a], [b]) => compare(a, b)));
  const plan = { format: 1 as const, fromManifestHash: installed.manifestHash, toManifestHash: release.manifestHash,
    currentManifestHash: current.manifestHash, actions: Object.freeze(actions), overrides: Object.freeze(orderedOverrides) };
  return Object.freeze({ ...plan, planHash: planDigest(plan) });
}
/** No private contents or even member content hashes leave the member's authorized context. */
export function resourceRolloutSummary(plan: TeamResourceUpdatePlan): { pendingGroups: number; conflictGroups: number; preservedGroups: number; deletedGroups: number } {
  return { pendingGroups: plan.actions.filter(action => action.action === "install" || action.action === "remove").length,
    conflictGroups: plan.actions.filter(action => action.action === "conflict").length,
    preservedGroups: plan.actions.filter(action => action.action === "preserve").length,
    deletedGroups: plan.actions.filter(action => action.reason === "member-deleted").length };
}

export interface ResourceUpdateReceipt {
  readonly format: 1;
  readonly operationId: string;
  readonly planHash: string;
  readonly status: "applying" | "complete" | "needs-attention";
  readonly completedGroups: readonly string[];
  readonly blockedGroup?: string;
}
export type ResourceUpdateStep =
  | { kind: "complete"; receipt: ResourceUpdateReceipt; installedManifestHash: string; overrides: ResourceOverrides }
  | { kind: "apply"; receipt: ResourceUpdateReceipt; action: ResourceUpdateAction }
  | { kind: "blocked"; receipt: ResourceUpdateReceipt; packageId: string };
function verifyPlan(plan: TeamResourceUpdatePlan): void {
  if (!plan || plan.format !== 1 || planDigest(plan) !== plan.planHash) throw new Error("Resource update plan changed after review");
  // Content hashes and path bounds remain enforced after JSON persistence.
  const member = plan.actions.flatMap(action => [...action.memberResources]);
  const team = plan.actions.flatMap(action => [...action.teamResources]);
  const current = validateTeamResourceSnapshot({ format: 1, resources: member, manifestHash: plan.currentManifestHash }, { requireCompleteSkills: false });
  const release = validateTeamResourceSnapshot({ format: 1, resources: team, manifestHash: plan.toManifestHash });
  assertCompatibleResourcePackages(current, release);
  assertCompatibleResourcePackageIds([...current.resources.map(resource => resource.packageId), ...release.resources.map(resource => resource.packageId), ...Object.keys(plan.overrides)]);
  const seen = new Set<string>();
  for (const action of plan.actions) {
    assertGroupId(action.packageId);
    if (seen.has(action.packageId)) throw new Error("Duplicate resource update group"); seen.add(action.packageId);
    if (action.memberResources.some(resource => resource.packageId !== action.packageId) || action.teamResources.some(resource => resource.packageId !== action.packageId)
      || action.beforeHash !== resourceGroupHash(action.memberResources) || action.teamHash !== resourceGroupHash(action.teamResources)) throw new Error("Invalid resource update group hashes");
    const apply = action.action === "install" || action.action === "remove";
    if (!["install", "remove", "preserve", "conflict"].includes(action.action) || action.afterHash !== (apply ? action.teamHash : action.beforeHash)
      || JSON.stringify(action.writeResources) !== JSON.stringify(apply ? action.teamResources : [])
      || JSON.stringify(action.removePaths) !== JSON.stringify(apply ? action.memberResources.filter(resource => !action.teamResources.some(target => target.path === resource.path)).map(resource => resource.path) : [])) throw new Error("Invalid resource update writes");
  }
}
function freezeReceipt(receipt: ResourceUpdateReceipt): ResourceUpdateReceipt {
  return Object.freeze({ ...receipt, completedGroups: Object.freeze([...receipt.completedGroups]) });
}
function verifyReceipt(plan: TeamResourceUpdatePlan, receipt: ResourceUpdateReceipt): void {
  verifyPlan(plan);
  const writes = plan.actions.filter(action => action.action === "install" || action.action === "remove");
  if (receipt.format !== 1 || receipt.planHash !== plan.planHash || !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.operationId)
    || !["applying", "complete", "needs-attention"].includes(receipt.status)
    || new Set(receipt.completedGroups).size !== receipt.completedGroups.length
    || receipt.completedGroups.some((id, index) => writes[index]?.packageId !== id)
    || (receipt.status === "complete" && receipt.completedGroups.length !== writes.length)
    || (receipt.status === "needs-attention" && !writes.some(action => action.packageId === receipt.blockedGroup))) throw new Error("Invalid resource update receipt");
}
/** Persist before the first runtime write. An operation ID may only identify one immutable plan. */
export function beginResourceUpdate(operationId: string, plan: TeamResourceUpdatePlan, existing?: ResourceUpdateReceipt): ResourceUpdateReceipt {
  verifyPlan(plan);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw new Error("Invalid resource update operation ID");
  if (existing) {
    verifyReceipt(plan, existing);
    if (existing.operationId !== operationId) throw new Error("Resource update operation ID mismatch");
    return freezeReceipt(existing);
  }
  return freezeReceipt({ format: 1, operationId, planHash: plan.planHash, status: "applying", completedGroups: [] });
}
/**
 * Under an exclusive runtime maintenance lease, re-read the next whole group. A crash after
 * atomic replacement but before recording the receipt is recognized by the exact after hash.
 * A partial write or new learning blocks recovery. Never replay over an unrecognized state.
 */
export function nextResourceUpdateStep(plan: TeamResourceUpdatePlan, receipt: ResourceUpdateReceipt, currentGroupHash: (packageId: string) => string): ResourceUpdateStep {
  verifyReceipt(plan, receipt);
  if (receipt.status === "needs-attention") return { kind: "blocked", receipt, packageId: receipt.blockedGroup! };
  const completed = new Set(receipt.completedGroups);
  for (const action of plan.actions.filter(action => action.action === "install" || action.action === "remove")) {
    if (completed.has(action.packageId)) continue;
    const actual = currentGroupHash(action.packageId);
    if (actual === action.afterHash) { completed.add(action.packageId); continue; }
    const nextReceipt = freezeReceipt({ ...receipt, status: "applying", completedGroups: [...completed] });
    if (actual !== action.beforeHash) {
      const blocked = freezeReceipt({ ...nextReceipt, status: "needs-attention", blockedGroup: action.packageId });
      return { kind: "blocked", receipt: blocked, packageId: action.packageId };
    }
    return { kind: "apply", receipt: nextReceipt, action };
  }
  const complete = freezeReceipt({ ...receipt, status: "complete", completedGroups: [...completed] });
  return { kind: "complete", receipt: complete, installedManifestHash: plan.toManifestHash, overrides: plan.overrides };
}
/** Record only a verified completed group. Persist this receipt before applying another group. */
export function recordResourceUpdateApplied(plan: TeamResourceUpdatePlan, receipt: ResourceUpdateReceipt, packageId: string, actualAfterHash: string): ResourceUpdateReceipt {
  verifyReceipt(plan, receipt);
  const action = plan.actions.find(action => action.packageId === packageId && (action.action === "install" || action.action === "remove"));
  if (receipt.status !== "applying" || !action || actualAfterHash !== action.afterHash) throw new Error("Resource update was not applied as reviewed");
  const pending = plan.actions.find(candidate => (candidate.action === "install" || candidate.action === "remove") && !receipt.completedGroups.includes(candidate.packageId));
  if (!receipt.completedGroups.includes(packageId) && pending?.packageId !== packageId) throw new Error("Resource update groups must complete in order");
  return freezeReceipt({ ...receipt, completedGroups: [...new Set([...receipt.completedGroups, packageId])] });
}
export { EMPTY_HASH as EMPTY_RESOURCE_GROUP_HASH };
