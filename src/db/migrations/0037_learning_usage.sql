ALTER TABLE "bot_learnings" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_learnings" ADD COLUMN "use_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_learnings" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bot_learnings" ADD COLUMN "last_curated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bot_learning_revisions" ADD COLUMN "kind" text;--> statement-breakpoint
UPDATE "bot_learning_revisions" AS revision SET "kind" = learning."kind" FROM "bot_learnings" AS learning WHERE revision."learning_id" = learning."id";--> statement-breakpoint
ALTER TABLE "bot_learning_revisions" ALTER COLUMN "kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_learning_revisions" ADD CONSTRAINT "bot_learning_revisions_kind_check" CHECK ("bot_learning_revisions"."kind" in ('preference', 'procedure', 'policy'));
