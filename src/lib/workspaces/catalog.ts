import "server-only";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { db, type DB, type DbOrTx } from "@/db";
import { workspaceTemplateVersions, workspaceTemplates } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import type { WorkspaceRecipe, WorkspaceTemplateSummary } from "@/lib/workspaces/contracts";
import { newId } from "@/lib/ids";
import { HttpError } from "@/lib/http-error";
import {
  assertWorkspaceCatalogAdmin,
  canonicalWorkspaceRecipe,
  parseWorkspaceRecipe,
  parseWorkspaceTemplateDraft,
} from "@/lib/workspaces/catalog-policy";

export type WorkspaceTemplateAdminVersion = {
  id: string;
  version: number;
  recipe: WorkspaceRecipe;
  recipeHash: string;
  publishedAt: string | null;
  retiredAt: string | null;
  createdAt: string;
};

export type WorkspaceTemplateAdminItem = {
  id: string;
  slug: string;
  name: string;
  description: string;
  activeVersionId: string | null;
  versions: WorkspaceTemplateAdminVersion[];
};

function recipeHash(recipe: WorkspaceRecipe): string {
  return createHash("sha256").update(canonicalWorkspaceRecipe(recipe)).digest("hex");
}

function checkedStoredRecipe(raw: unknown, storedHash: string): WorkspaceRecipe {
  const recipe = parseWorkspaceRecipe(raw);
  if (recipeHash(recipe) !== storedHash) throw new HttpError(409, "Workspace template recipe integrity check failed");
  return recipe;
}

function readId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(value)) {
    throw new HttpError(400, "Invalid workspace template identifier");
  }
  return value;
}

export async function createWorkspaceTemplateDraft(
  principal: Principal,
  raw: unknown,
  database: DB = db,
) {
  assertWorkspaceCatalogAdmin(principal);
  const input = parseWorkspaceTemplateDraft(raw);
  const templateId = newId();
  const versionId = newId();
  const hash = recipeHash(input.recipe);

  await database.transaction(async (tx) => {
    await tx.insert(workspaceTemplates).values({
      id: templateId,
      slug: input.slug,
      name: input.name,
      description: input.description,
    });
    await tx.insert(workspaceTemplateVersions).values({
      id: versionId,
      templateId,
      version: 1,
      recipe: input.recipe,
      recipeHash: hash,
    });
  });

  return { templateId, versionId, version: 1, recipeHash: hash };
}

/** Creates the next immutable-on-publish revision while serializing writers on the template row. */
export async function createWorkspaceTemplateVersion(
  principal: Principal,
  templateIdInput: unknown,
  rawRecipe: unknown,
  database: DB = db,
) {
  assertWorkspaceCatalogAdmin(principal);
  const templateId = readId(templateIdInput);
  const recipe = parseWorkspaceRecipe(rawRecipe);
  const hash = recipeHash(recipe);

  return database.transaction(async (tx) => {
    const [template] = await tx
      .select({ id: workspaceTemplates.id })
      .from(workspaceTemplates)
      .where(eq(workspaceTemplates.id, templateId))
      .for("update");
    if (!template) throw new HttpError(404, "Workspace template not found");

    const [latest] = await tx
      .select({ version: workspaceTemplateVersions.version })
      .from(workspaceTemplateVersions)
      .where(eq(workspaceTemplateVersions.templateId, templateId))
      .orderBy(desc(workspaceTemplateVersions.version))
      .limit(1);
    const version = (latest?.version ?? 0) + 1;
    const versionId = newId();
    await tx.insert(workspaceTemplateVersions).values({
      id: versionId,
      templateId,
      version,
      recipe,
      recipeHash: hash,
    });
    return { templateId, versionId, version, recipeHash: hash };
  });
}

/** Publishing selects one active catalog version and retires the previous active version. */
export async function publishWorkspaceTemplateVersion(
  principal: Principal,
  versionIdInput: unknown,
  database: DB = db,
) {
  assertWorkspaceCatalogAdmin(principal);
  const versionId = readId(versionIdInput);
  return database.transaction(async (tx) => {
    const [initial] = await tx
      .select({ templateId: workspaceTemplateVersions.templateId })
      .from(workspaceTemplateVersions)
      .where(eq(workspaceTemplateVersions.id, versionId))
      .limit(1);
    if (!initial) throw new HttpError(404, "Workspace template version not found");

    await tx
      .select({ id: workspaceTemplates.id })
      .from(workspaceTemplates)
      .where(eq(workspaceTemplates.id, initial.templateId))
      .for("update");

    const [candidate] = await tx
      .select({
        publishedAt: workspaceTemplateVersions.publishedAt,
        retiredAt: workspaceTemplateVersions.retiredAt,
        recipe: workspaceTemplateVersions.recipe,
        recipeHash: workspaceTemplateVersions.recipeHash,
      })
      .from(workspaceTemplateVersions)
      .where(eq(workspaceTemplateVersions.id, versionId))
      .limit(1);
    if (!candidate) throw new HttpError(404, "Workspace template version not found");
    if (candidate.publishedAt || candidate.retiredAt) throw new HttpError(409, "Only an active draft can be published");
    checkedStoredRecipe(candidate.recipe, candidate.recipeHash);

    await tx
      .update(workspaceTemplateVersions)
      .set({ retiredAt: sql`greatest(now(), ${workspaceTemplateVersions.publishedAt})` })
      .where(and(
        eq(workspaceTemplateVersions.templateId, initial.templateId),
        isNotNull(workspaceTemplateVersions.publishedAt),
        isNull(workspaceTemplateVersions.retiredAt),
        ne(workspaceTemplateVersions.id, versionId),
      ));
    const [published] = await tx
      .update(workspaceTemplateVersions)
      .set({ publishedAt: new Date() })
      .where(and(eq(workspaceTemplateVersions.id, versionId), isNull(workspaceTemplateVersions.publishedAt)))
      .returning({ id: workspaceTemplateVersions.id, templateId: workspaceTemplateVersions.templateId, version: workspaceTemplateVersions.version, recipeHash: workspaceTemplateVersions.recipeHash });
    if (!published) throw new HttpError(409, "Workspace template version is no longer a draft");
    return published;
  });
}

/** Retirement prevents future selection; existing instances remain pinned to their version. */
export async function retireWorkspaceTemplateVersion(
  principal: Principal,
  versionIdInput: unknown,
  database: DB = db,
) {
  assertWorkspaceCatalogAdmin(principal);
  const versionId = readId(versionIdInput);
  return database.transaction(async (tx) => {
    const [initial] = await tx
      .select({ templateId: workspaceTemplateVersions.templateId })
      .from(workspaceTemplateVersions)
      .where(eq(workspaceTemplateVersions.id, versionId))
      .limit(1);
    if (!initial) throw new HttpError(404, "Workspace template version not found");
    await tx
      .select({ id: workspaceTemplates.id })
      .from(workspaceTemplates)
      .where(eq(workspaceTemplates.id, initial.templateId))
      .for("update");

    const [version] = await tx
      .select({ publishedAt: workspaceTemplateVersions.publishedAt, retiredAt: workspaceTemplateVersions.retiredAt })
      .from(workspaceTemplateVersions)
      .where(eq(workspaceTemplateVersions.id, versionId))
      .limit(1);
    if (!version) throw new HttpError(404, "Workspace template version not found");
    if (!version.publishedAt) throw new HttpError(409, "A draft cannot be retired before publication");
    if (version.retiredAt) throw new HttpError(409, "Workspace template version is already retired");

    const [retired] = await tx
      .update(workspaceTemplateVersions)
      .set({ retiredAt: sql`greatest(now(), ${workspaceTemplateVersions.publishedAt})` })
      .where(and(eq(workspaceTemplateVersions.id, versionId), isNull(workspaceTemplateVersions.retiredAt)))
      .returning({ id: workspaceTemplateVersions.id, templateId: workspaceTemplateVersions.templateId, version: workspaceTemplateVersions.version, recipeHash: workspaceTemplateVersions.recipeHash });
    if (!retired) throw new HttpError(409, "Workspace template version is already retired");
    return retired;
  });
}

export async function listAdminWorkspaceTemplates(
  principal: Principal,
  query: DbOrTx = db,
): Promise<WorkspaceTemplateAdminItem[]> {
  assertWorkspaceCatalogAdmin(principal);
  const templates = await query
    .select({ id: workspaceTemplates.id, slug: workspaceTemplates.slug, name: workspaceTemplates.name, description: workspaceTemplates.description })
    .from(workspaceTemplates)
    .orderBy(asc(workspaceTemplates.name), asc(workspaceTemplates.slug));
  if (!templates.length) return [];

  const versions = await query
    .select({
      id: workspaceTemplateVersions.id,
      templateId: workspaceTemplateVersions.templateId,
      version: workspaceTemplateVersions.version,
      recipe: workspaceTemplateVersions.recipe,
      recipeHash: workspaceTemplateVersions.recipeHash,
      publishedAt: workspaceTemplateVersions.publishedAt,
      retiredAt: workspaceTemplateVersions.retiredAt,
      createdAt: workspaceTemplateVersions.createdAt,
    })
    .from(workspaceTemplateVersions)
    .orderBy(asc(workspaceTemplateVersions.templateId), desc(workspaceTemplateVersions.version));
  const versionsByTemplate = new Map<string, WorkspaceTemplateAdminVersion[]>();
  for (const row of versions) {
    const list = versionsByTemplate.get(row.templateId) ?? [];
    list.push({
      id: row.id,
      version: row.version,
      recipe: checkedStoredRecipe(row.recipe, row.recipeHash),
      recipeHash: row.recipeHash,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      retiredAt: row.retiredAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    });
    versionsByTemplate.set(row.templateId, list);
  }

  return templates.map((template) => {
    const templateVersions = versionsByTemplate.get(template.id) ?? [];
    return {
      ...template,
      activeVersionId: templateVersions.find((version) => version.publishedAt && !version.retiredAt)?.id ?? null,
      versions: templateVersions,
    };
  });
}

/** Public picker projection: signed-in users receive summaries, never raw recipes or server profile details. */
export async function listVisibleWorkspaceTemplates(query: DbOrTx = db): Promise<WorkspaceTemplateSummary[]> {
  const rows = await query
    .select({
      id: workspaceTemplates.id,
      slug: workspaceTemplates.slug,
      name: workspaceTemplates.name,
      description: workspaceTemplates.description,
      versionId: workspaceTemplateVersions.id,
      recipe: workspaceTemplateVersions.recipe,
      recipeHash: workspaceTemplateVersions.recipeHash,
    })
    .from(workspaceTemplateVersions)
    .innerJoin(workspaceTemplates, eq(workspaceTemplateVersions.templateId, workspaceTemplates.id))
    .where(and(isNotNull(workspaceTemplateVersions.publishedAt), isNull(workspaceTemplateVersions.retiredAt)))
    .orderBy(asc(workspaceTemplates.name), asc(workspaceTemplates.slug), desc(workspaceTemplateVersions.version));

  const summaries: WorkspaceTemplateSummary[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const recipe = checkedStoredRecipe(row.recipe, row.recipeHash);
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    summaries.push({
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      publishedVersionId: row.versionId,
      capabilities: { ...recipe.capabilities },
    });
  }
  return summaries;
}
