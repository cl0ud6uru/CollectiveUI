"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePrincipal } from "@/lib/session";
import { changeLearning, learningHistory } from "@/lib/agent/learning/store";
import { lessonContentSchema } from "@/lib/agent/learning/types";

const changeSchema = z.object({
  id: z.string().min(1).max(100), version: z.number().int().positive(),
  pinned: z.boolean().optional(),
  status: z.enum(["active", "archived"]).optional(),
  content: lessonContentSchema.optional(), restoreVersion: z.number().int().positive().optional(),
});

export async function updateLearning(raw: z.infer<typeof changeSchema>) {
  const p = await requirePrincipal();
  const input = changeSchema.parse(raw);
  const botId = await changeLearning(p, input.id, input.version, input);
  revalidatePath(`/bots/${botId}`);
}

export async function getLearningHistory(id: string) {
  const p = await requirePrincipal();
  const rows = await learningHistory(p, z.string().min(1).max(100).parse(id));
  return rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() }));
}
