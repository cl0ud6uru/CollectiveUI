"use server";

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { HttpError } from "@/lib/http-error";
import { requireAdmin } from "@/lib/session";
import {
  createWorkspaceTemplateDraft as createDraft,
  createWorkspaceTemplateVersion as createVersion,
  publishWorkspaceTemplateVersion as publishVersion,
  retireWorkspaceTemplateVersion as retireVersion,
} from "@/lib/workspaces/catalog";
import { parseWorkspaceRecipeForm } from "@/lib/workspaces/catalog-policy";

type ActionResult = { ok: true } | { ok: false; error: string };

function actionError(error: unknown): ActionResult {
  if (error instanceof HttpError) return { ok: false, error: error.message };
  console.error("Workspace template catalog mutation failed", error);
  return { ok: false, error: "The template could not be saved. Check the fields and try again." };
}

export async function createWorkspaceTemplateDraft(form: FormData): Promise<ActionResult> {
  const principal = await requireAdmin();
  try {
    if (!(form instanceof FormData)) throw new HttpError(400, "Invalid template form");
    const created = await createDraft(principal, {
      slug: form.get("slug"),
      name: form.get("name"),
      description: form.get("description"),
      recipe: parseWorkspaceRecipeForm(form),
    });
    await audit(principal.user.id, "workspace_template.draft.create", created.templateId, {
      version: created.version,
      recipeHash: created.recipeHash,
    });
    revalidatePath("/admin/workspace-templates");
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}

export async function createWorkspaceTemplateVersion(form: FormData): Promise<ActionResult> {
  const principal = await requireAdmin();
  try {
    if (!(form instanceof FormData)) throw new HttpError(400, "Invalid version form");
    const created = await createVersion(principal, form.get("templateId"), parseWorkspaceRecipeForm(form));
    await audit(principal.user.id, "workspace_template.version.create", created.templateId, {
      version: created.version,
      recipeHash: created.recipeHash,
    });
    revalidatePath("/admin/workspace-templates");
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}

export async function publishWorkspaceTemplateVersion(versionId: string): Promise<ActionResult> {
  const principal = await requireAdmin();
  try {
    const published = await publishVersion(principal, versionId);
    await audit(principal.user.id, "workspace_template.version.publish", published.templateId, {
      version: published.version,
      recipeHash: published.recipeHash,
    });
    revalidatePath("/admin/workspace-templates");
    revalidatePath("/api/workspace/templates");
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}

export async function retireWorkspaceTemplateVersion(versionId: string): Promise<ActionResult> {
  const principal = await requireAdmin();
  try {
    const retired = await retireVersion(principal, versionId);
    await audit(principal.user.id, "workspace_template.version.retire", retired.templateId, {
      version: retired.version,
      recipeHash: retired.recipeHash,
    });
    revalidatePath("/admin/workspace-templates");
    revalidatePath("/api/workspace/templates");
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}
