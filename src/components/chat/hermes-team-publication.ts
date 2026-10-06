/** Browser wire types for the reviewed Team publication API. The server validates every selection. */
export type HermesTeamCaptureSelection = { skillPackages: string[]; includeRole: boolean; documents: string[] };
export type HermesTeamCaptureInventory = { available: boolean; selection: HermesTeamCaptureSelection; reason?: string };
export type HermesTeamCapturedResource = {
  path: string; kind: "skill" | "role" | "document"; packageId: string;
  sha256: string; encoding: "utf8" | "base64"; content: string; size: number;
};
export type HermesTeamResourceChange = {
  packageId: string; change: "added" | "changed" | "removed"; beforeHash: string; afterHash: string;
  previousResources: readonly HermesTeamCapturedResource[]; capturedResources: readonly HermesTeamCapturedResource[];
};
export type HermesTeamReview = {
  snapshotId: string; expectedRevision: number; definitionVersion: number; manifestHash: string;
  expiresAt: string; changes: readonly HermesTeamResourceChange[];
};
export type HermesTeamPublishInput = {
  snapshotId: string; expectedRevision: number; selectedKeys: string[]; removalKeys: string[];
  releaseNote: string; requestId: string;
};
export function publicationResourceName(change: HermesTeamResourceChange): string {
  const kind = (change.capturedResources[0] ?? change.previousResources[0])?.kind;
  return kind === "role" ? "Role instructions" : change.packageId.replace(/^(?:skills|documents)\//, "");
}
export function publicationResourceKind(change: HermesTeamResourceChange): string {
  const kind = (change.capturedResources[0] ?? change.previousResources[0])?.kind;
  return kind === "role" ? "Role instructions" : kind === "document" ? "Shared document" : "Complete skill package";
}
export function publicationPackageFiles(change: HermesTeamResourceChange) {
  const before = new Map(change.previousResources.map(file => [file.path, file]));
  const after = new Map(change.capturedResources.map(file => [file.path, file]));
  return [...new Set([...before.keys(), ...after.keys()])].sort().map(path => ({ path, before: before.get(path), after: after.get(path) }));
}
