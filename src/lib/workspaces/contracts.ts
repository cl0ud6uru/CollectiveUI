/** Shared types only. Recipes describe reusable resources, never private files or credentials. */
export type WorkspaceCapabilities = {
  shell: boolean;
  officeHeadless: boolean;
  dotnet: boolean;
  agentBrowserView: boolean;
};

export type WorkspaceRecipe = {
  schemaVersion: 1;
  /** A key in the daemon's server-installed allowlist, never an image or endpoint. */
  runtimeProfileKey: string;
  /** Immutable bundled initial files; never a user's live filesystem. */
  seedBundleKey: string | null;
  networkPolicy: "none";
  capabilities: WorkspaceCapabilities;
};

export type WorkspaceTemplateVersion = {
  id: string;
  templateId: string;
  version: number;
  recipe: WorkspaceRecipe;
  /** SHA-256 of the canonical recipe, computed server-side. */
  recipeHash: string;
  publishedAt: string | null;
  retiredAt: string | null;
};

export type WorkspaceTemplateSummary = {
  id: string;
  slug: string;
  name: string;
  description: string;
  publishedVersionId: string | null;
  capabilities: WorkspaceCapabilities;
};

export type WorkspaceInstanceOrigin = "legacy_personal" | "template";
export type WorkspaceProvisionState = "missing" | "provisioning" | "ready" | "unavailable";

/** Public projection: no daemon references, profile paths, native identities, or endpoints. */
export type WorkspaceInstanceView = {
  id: string;
  templateVersionId: string | null;
  templateName: string | null;
  origin: WorkspaceInstanceOrigin;
  state: WorkspaceProvisionState;
};

/** SERVER ONLY: must never be serialized into UI/API DTOs. */
export type ResolvedWorkspace = {
  instanceId: string;
  ownerUserId: string;
  botId: string | null;
  templateVersionId: string | null;
  sandboxRef: string;
  runtimeProfileKey: string;
  workspaceRoot: "/home/agent/workspace";
};

/** Client selectors only: owner, sandbox ref, image and profile are server-resolved. */
export type WorkspaceTemplateAssignment = { botId: string; templateVersionId: string };
export type WorkspaceTemplateAssignmentResult = { instance: WorkspaceInstanceView };
export type WorkspaceInstanceList = { instances: WorkspaceInstanceView[] };
export type WorkspaceTemplateList = { templates: WorkspaceTemplateSummary[] };
