import { z } from "zod";
import { getWorkspaceRuntimeProfile } from "@/sandboxd/profiles";
import type { WorkspaceRecipe } from "./contracts";
import type { Health } from "@/sandboxd/protocol/types";

const recipeSchema = z.object({
  schemaVersion: z.literal(1),
  runtimeProfileKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),
  seedBundleKey: z.string().max(128).nullable(),
  networkPolicy: z.literal("none"),
  capabilities: z.object({
    shell: z.boolean(),
    officeHeadless: z.boolean(),
    dotnet: z.boolean(),
    agentBrowserView: z.boolean(),
  }).strict(),
}).strict();

export class WorkspaceRecipePolicyError extends Error {
  constructor(message: string, readonly code: "policy" | "image_missing" = "policy") {
    super(message);
    this.name = "WorkspaceRecipePolicyError";
  }
}

/** Validate a stored recipe against the daemon's fixed server allowlist before creating a private instance. */
export function admitWorkspaceRecipe(input: unknown, installedProfiles?: Health["profiles"]): { recipe: WorkspaceRecipe; profile: NonNullable<ReturnType<typeof getWorkspaceRuntimeProfile>> } {
  const parsed = recipeSchema.safeParse(input);
  if (!parsed.success) throw new WorkspaceRecipePolicyError("This workspace template has an invalid recipe.");
  const profile = getWorkspaceRuntimeProfile(parsed.data.runtimeProfileKey);
  if (!profile || profile.key === "legacy") throw new WorkspaceRecipePolicyError("This workspace template uses a runtime profile that is not installed on this server.");
  if (parsed.data.seedBundleKey !== profile.seedBundleKey || profile.seedBundleKey === null) {
    throw new WorkspaceRecipePolicyError("This workspace template does not match its profile's pinned starter bundle.");
  }
  for (const [key, enabled] of Object.entries(parsed.data.capabilities)) {
    if (enabled && !profile.capabilities[key as keyof typeof profile.capabilities]) {
      throw new WorkspaceRecipePolicyError("This workspace template requests a capability its runtime profile does not allow.");
    }
  }
  const installed = installedProfiles?.find(candidate => candidate.key === profile.key && candidate.installed === true);
  if (!installed?.imageId || !/^sha256:[0-9a-f]{64}$/.test(installed.imageId)) {
    throw new WorkspaceRecipePolicyError("The workspace service does not report an installed pinned image for this template.", "image_missing");
  }
  return { recipe: parsed.data, profile: { ...profile, imageRef: installed.imageId } };
}
