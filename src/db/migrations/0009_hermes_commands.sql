CREATE TABLE "hermes_chat_settings" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"target_key" text NOT NULL,
	"model" text,
	"revision" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hermes_run_contexts" (
	"run_id" text PRIMARY KEY NOT NULL,
	"target_key" text NOT NULL,
	"model" text,
	"upstream_run_id" text,
	"stop_state" text
);
--> statement-breakpoint
ALTER TABLE "hermes_chat_settings" ADD CONSTRAINT "hermes_chat_settings_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_run_contexts" ADD CONSTRAINT "hermes_run_contexts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;