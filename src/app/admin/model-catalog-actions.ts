"use server";

import { requireAdmin } from "@/lib/session";
import { readOpenRouterCatalog } from "@/lib/llm/model-catalog";

export async function listOpenRouterModels() {
  await requireAdmin();
  return readOpenRouterCatalog();
}
