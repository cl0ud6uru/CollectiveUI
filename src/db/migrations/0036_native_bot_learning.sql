CREATE TABLE "bot_learning_reviews" (
	"run_id" text PRIMARY KEY NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_learning_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"learning_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"content" jsonb NOT NULL,
	"verification" text NOT NULL,
	"source_conversation_id" text,
	"source_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_learnings" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"user_id" text,
	"topic" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"content" jsonb NOT NULL,
	"verification" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_learnings_status_check" CHECK ("bot_learnings"."status" in ('active', 'pending', 'archived')),
	CONSTRAINT "bot_learnings_kind_check" CHECK ("bot_learnings"."kind" in ('preference', 'procedure', 'policy')),
	CONSTRAINT "bot_learnings_preference_scope_check" CHECK ("bot_learnings"."kind" <> 'preference' or "bot_learnings"."user_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "bot_learning_reviews" ADD CONSTRAINT "bot_learning_reviews_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_learning_revisions" ADD CONSTRAINT "bot_learning_revisions_learning_id_bot_learnings_id_fk" FOREIGN KEY ("learning_id") REFERENCES "public"."bot_learnings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_learning_revisions" ADD CONSTRAINT "bot_learning_revisions_source_conversation_id_conversations_id_fk" FOREIGN KEY ("source_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_learnings" ADD CONSTRAINT "bot_learnings_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_learnings" ADD CONSTRAINT "bot_learnings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_learning_revisions_version_idx" ON "bot_learning_revisions" USING btree ("learning_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_learnings_shared_topic_idx" ON "bot_learnings" USING btree ("bot_id","topic") WHERE "bot_learnings"."user_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_learnings_user_topic_idx" ON "bot_learnings" USING btree ("bot_id","user_id","topic") WHERE "bot_learnings"."user_id" is not null;
