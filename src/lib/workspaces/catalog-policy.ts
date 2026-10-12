import { z } from "zod";
import type { WorkspaceRecipe } from "@/lib/workspaces/contracts";
import type { Principal } from "@/lib/auth/groups";
import { HttpError } from "@/lib/http-error";

/**
 * Operator-maintained catalog allowlist. Profile identifiers are validated here,
 * but allowlisting does not prove a runtime image exists or is admitted. Callers
 * can never supply an image, endpoint, or profile path. The browser viewer remains
 * unavailable until a real same-session source is integrated.
 */
export const WORKSPACE_RUNTIME_PROFILE_ALLOWLIST = {
  "knowledge-work-v1": {
    label: "Knowledge Work",
    templateSlug: "knowledge-work",
    templateName: "Knowledge Work",
    description: "Prebuilt Office workspace for writing, spreadsheets, and presentations.",
    seedBundleKey: "knowledge-work-v1",
    capabilities: { shell: true, officeHeadless: true, dotnet: false, agentBrowserView: false },
  },
  "dotnet-linux-v1": {
    label: ".NET Linux",
    templateSlug: "dotnet-linux",
    templateName: ".NET Linux",
    description: "Offline Linux .NET console starter workspace.",
    seedBundleKey: "dotnet-linux-v1",
    capabilities: { shell: true, officeHeadless: false, dotnet: true, agentBrowserView: false },
  },
} as const;

export type WorkspaceRuntimeProfileKey = keyof typeof WORKSPACE_RUNTIME_PROFILE_ALLOWLIST;
export type WorkspaceCatalogProfileOption = {
  key: WorkspaceRuntimeProfileKey;
  label: string;
  templateSlug: string;
  templateName: string;
  description: string;
  seedBundleKey: string;
  seedBundleKeys: string[];
  capabilities: WorkspaceRecipe["capabilities"];
};

export function listWorkspaceCatalogProfileOptions(): WorkspaceCatalogProfileOption[] {
  return Object.entries(WORKSPACE_RUNTIME_PROFILE_ALLOWLIST).map(([key, profile]) => ({
    key: key as WorkspaceRuntimeProfileKey,
    label: profile.label,
    templateSlug: profile.templateSlug,
    templateName: profile.templateName,
    description: profile.description,
    seedBundleKey: profile.seedBundleKey,
    seedBundleKeys: [profile.seedBundleKey],
    capabilities: { ...profile.capabilities },
  }));
}

const recipeSchema = z.object({
  schemaVersion: z.literal(1),
  runtimeProfileKey: z.enum(Object.keys(WORKSPACE_RUNTIME_PROFILE_ALLOWLIST) as [WorkspaceRuntimeProfileKey, ...WorkspaceRuntimeProfileKey[]]),
  seedBundleKey: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
  networkPolicy: z.literal("none"),
  capabilities: z.object({
    shell: z.boolean(),
    officeHeadless: z.boolean(),
    dotnet: z.boolean(),
    agentBrowserView: z.boolean(),
  }).strict(),
}).strict();

const templateDraftSchema = z.object({
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500),
}).strict();

export type WorkspaceTemplateDraftInput = z.infer<typeof templateDraftSchema> & { recipe: WorkspaceRecipe };

export function assertWorkspaceCatalogAdmin(principal: Pick<Principal, "isAdmin">): void {
  if (!principal.isAdmin) throw new HttpError(403, "Admin only");
}

function invalidInput(error: z.ZodError): HttpError {
  const first = error.issues[0];
  return new HttpError(400, first?.message ?? "Invalid workspace template input");
}

export function parseWorkspaceRecipe(raw: unknown): WorkspaceRecipe {
  let recipe: WorkspaceRecipe;
  try {
    recipe = recipeSchema.parse(raw) as WorkspaceRecipe;
  } catch (error) {
    if (error instanceof z.ZodError) throw invalidInput(error);
    throw error;
  }

  const profileKey = recipe.runtimeProfileKey as WorkspaceRuntimeProfileKey;
  const profile = WORKSPACE_RUNTIME_PROFILE_ALLOWLIST[profileKey];
  if (recipe.seedBundleKey !== profile.seedBundleKey) {
    throw new HttpError(400, "Starter bundle is not allowlisted for this runtime profile");
  }
  for (const [capability, enabled] of Object.entries(recipe.capabilities) as Array<[keyof WorkspaceRecipe["capabilities"], boolean]>) {
    if (enabled && !profile.capabilities[capability]) {
      throw new HttpError(400, `The ${capability} capability is not allowlisted for this runtime profile`);
    }
  }
  return recipe;
}

/** Prebuilt slugs have a frozen display/profile/seed mapping shared with W3's manifest. */
export function assertWorkspaceTemplateRecipeForSlug(slug: string, recipe: WorkspaceRecipe): void {
  const entry = Object.entries(WORKSPACE_RUNTIME_PROFILE_ALLOWLIST).find(([, profile]) => profile.templateSlug === slug);
  if (!entry) return;
  const [profileKey, profile] = entry as [WorkspaceRuntimeProfileKey, (typeof WORKSPACE_RUNTIME_PROFILE_ALLOWLIST)[WorkspaceRuntimeProfileKey]];
  if (recipe.runtimeProfileKey !== profileKey || recipe.seedBundleKey !== profile.seedBundleKey) {
    throw new HttpError(400, `The ${profile.templateName} starter must use its matching runtime profile and seed bundle`);
  }
}

export function assertWorkspaceTemplateNameForSlug(slug: string, name: string): void {
  const profile = Object.values(WORKSPACE_RUNTIME_PROFILE_ALLOWLIST).find((entry) => entry.templateSlug === slug);
  if (profile && name !== profile.templateName) {
    throw new HttpError(400, `The ${profile.templateName} starter must keep its canonical display name`);
  }
}

export function parseWorkspaceTemplateDraft(raw: unknown): WorkspaceTemplateDraftInput {
  try {
    const input = templateDraftSchema.extend({ recipe: z.unknown() }).strict().parse(raw);
    const { recipe, ...metadata } = input;
    const parsedRecipe = parseWorkspaceRecipe(recipe);
    assertWorkspaceTemplateNameForSlug(metadata.slug, metadata.name);
    assertWorkspaceTemplateRecipeForSlug(metadata.slug, parsedRecipe);
    return { ...metadata, recipe: parsedRecipe };
  } catch (error) {
    if (error instanceof z.ZodError) throw invalidInput(error);
    throw error;
  }
}

/** Read only the named fields from a form and hard-code frozen recipe policy. */
export function parseWorkspaceRecipeForm(form: FormData): WorkspaceRecipe {
  if (!(form instanceof FormData)) throw new HttpError(400, "Invalid recipe form");
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const checked = (name: string) => form.get(name) === "on";
  return parseWorkspaceRecipe({
    schemaVersion: 1,
    runtimeProfileKey: text("runtimeProfileKey"),
    seedBundleKey: text("seedBundleKey") || null,
    networkPolicy: "none",
    capabilities: {
      shell: checked("shell"),
      officeHeadless: checked("officeHeadless"),
      dotnet: checked("dotnet"),
      agentBrowserView: checked("agentBrowserView"),
    },
  });
}

/** Canonical property order makes hashes independent of caller object insertion order. */
export function canonicalWorkspaceRecipe(recipe: WorkspaceRecipe): string {
  return JSON.stringify({
    schemaVersion: recipe.schemaVersion,
    runtimeProfileKey: recipe.runtimeProfileKey,
    seedBundleKey: recipe.seedBundleKey,
    networkPolicy: recipe.networkPolicy,
    capabilities: {
      shell: recipe.capabilities.shell,
      officeHeadless: recipe.capabilities.officeHeadless,
      dotnet: recipe.capabilities.dotnet,
      agentBrowserView: recipe.capabilities.agentBrowserView,
    },
  });
}
