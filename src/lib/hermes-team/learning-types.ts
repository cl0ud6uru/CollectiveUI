import { z } from 'zod';
import { canonicalTeamToolInput } from './tool-policy';

/** Captured by the pinned native review chokepoint; never a browser prompt or profile selector. */
export const NativeTeamLearningSnapshotSchema=z.object({
  version:z.literal(1),messagesSnapshot:z.array(z.record(z.string(),z.unknown())).min(1).max(256),
  reviewMemory:z.boolean(),reviewSkills:z.boolean(),focus:z.string().max(2000).nullable(),explicit:z.boolean(),
  memoryEnabled:z.boolean(),userProfileEnabled:z.boolean(),
}).strict().refine(value=>value.reviewMemory || value.reviewSkills,'A native review scope is required.');
export type NativeTeamLearningSnapshot=z.infer<typeof NativeTeamLearningSnapshotSchema>;
export const NativeTeamLearningHandoffSchema=z.object({reviewId:z.uuid(),snapshot:NativeTeamLearningSnapshotSchema}).strict();
export function validateNativeTeamLearningSnapshot(value:unknown):NativeTeamLearningSnapshot{
  // The shared canonical JSON bound is 64KB, 10,000 nodes and depth20, including string/key bytes.
  canonicalTeamToolInput(value);return NativeTeamLearningSnapshotSchema.parse(value);
}
export const TEAM_LEARNING_LIFETIME_MS=15*60_000;
