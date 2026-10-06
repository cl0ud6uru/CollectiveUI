import { z } from "zod";

export const lessonContentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(400),
  instructions: z.string().trim().min(1).max(6000),
  expectedOutput: z.string().max(1000),
  boundaries: z.string().max(1000),
});
export type LessonContent = z.infer<typeof lessonContentSchema>;
export type LessonStatus = "active" | "pending" | "archived";

export const learningReviewSchema = z.object({
  lessons: z.array(lessonContentSchema.extend({
    topic: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
    scope: z.enum(["user", "bot"]),
    kind: z.enum(["preference", "procedure", "policy"]),
    baseVersion: z.number().int().min(0),
    evidenceCallIds: z.array(z.string()).max(10),
    verification: z.string().trim().min(1).max(800),
  })).max(3),
});
export type ReviewedLesson = z.infer<typeof learningReviewSchema>["lessons"][number];

/** Client projection deliberately omits source conversation/run IDs and other users' identities. */
export type LearningView = {
  id: string;
  kind: "preference" | "procedure" | "policy";
  pinned: boolean;
  useCount: number;
  lastUsedAt: string | null;
  stale: boolean;
  scope: "user" | "bot";
  status: LessonStatus;
  content: LessonContent;
  verification: string;
  version: number;
  canManage: boolean;
  updatedAt: string;
};
