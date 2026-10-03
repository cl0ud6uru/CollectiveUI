"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { configureCoordinator, createCoordinatorStarter } from "@/lib/coordinator/store";

export async function saveCoordinator(raw: unknown) {
  const p = await requireAdmin();
  await configureCoordinator(p, raw);
  revalidatePath("/", "layout");
}

export async function createQueenStarter(raw: unknown) {
  const p = await requireAdmin();
  const result = await createCoordinatorStarter(p, raw);
  revalidatePath("/", "layout");
  return result;
}
