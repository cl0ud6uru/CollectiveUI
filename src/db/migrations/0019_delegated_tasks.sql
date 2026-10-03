CREATE TABLE "delegated_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"origin_conversation_id" text,
	"origin_message_id" text NOT NULL,
	"origin_tool_call_id" text NOT NULL,
	"parent_run_id" text,
	"parent_task_id" text,
	"root_task_id" text NOT NULL,
	"root_message_id" text NOT NULL,
	"assigner_bot_id" text NOT NULL,
	"receiver_bot_id" text NOT NULL,
	"assigner_name" text NOT NULL,
	"receiver_name" text NOT NULL,
	"child_conversation_id" text,
	"child_run_id" text,
	"input_hash" text NOT NULL,
	"depth" integer NOT NULL,
	"ancestry" jsonb NOT NULL,
	"session_version" integer NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"returned_at" timestamp with time zone,
	"parent_result_seq" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delegated_tasks_depth_check" CHECK ("delegated_tasks"."depth" between 1 and 2)
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "execution_mode" text DEFAULT 'worker' NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD COLUMN "provider_call_id" text;--> statement-breakpoint
ALTER TABLE "delegated_tasks" ADD CONSTRAINT "delegated_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegated_tasks" ADD CONSTRAINT "delegated_tasks_origin_conversation_id_conversations_id_fk" FOREIGN KEY ("origin_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegated_tasks" ADD CONSTRAINT "delegated_tasks_parent_run_id_agent_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegated_tasks" ADD CONSTRAINT "delegated_tasks_child_conversation_id_conversations_id_fk" FOREIGN KEY ("child_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegated_tasks" ADD CONSTRAINT "delegated_tasks_child_run_id_agent_runs_id_fk" FOREIGN KEY ("child_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delegated_tasks_origin_idx" ON "delegated_tasks" USING btree ("user_id","origin_message_id","origin_tool_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delegated_tasks_conversation_idx" ON "delegated_tasks" USING btree ("child_conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delegated_tasks_run_idx" ON "delegated_tasks" USING btree ("child_run_id");--> statement-breakpoint
CREATE INDEX "delegated_tasks_receiver_idx" ON "delegated_tasks" USING btree ("user_id","receiver_bot_id","created_at");--> statement-breakpoint
CREATE INDEX "delegated_tasks_root_idx" ON "delegated_tasks" USING btree ("user_id","root_message_id");--> statement-breakpoint
CREATE INDEX "delegated_tasks_parent_idx" ON "delegated_tasks" USING btree ("parent_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_calls_message_call_idx" ON "tool_calls" USING btree ("message_id","provider_call_id");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_execution_mode_check" CHECK ("agent_runs"."execution_mode" in ('worker', 'inline_delegate'));--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_inline_check" CHECK ("agent_runs"."execution_mode" <> 'inline_delegate' or ("agent_runs"."status" not in ('queued', 'waiting') and "agent_runs"."routine_run_id" is null and "agent_runs"."segment" = 0));
--> statement-breakpoint
-- Preserve legacy audit identities and continue updating approvals in-place after upgrade.
UPDATE tool_calls SET provider_call_id = id WHERE provider_call_id IS NULL;
--> statement-breakpoint
UPDATE tool_calls tc SET run_id = ar.id FROM agent_runs ar WHERE ar.message_id = tc.message_id;
