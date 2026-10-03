CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"message_id" text NOT NULL,
	"parent_message_id" text,
	"app_id" text,
	"bot_id" text,
	"routine_run_id" text,
	"background" boolean DEFAULT false NOT NULL,
	"legacy" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"segment" integer DEFAULT 0 NOT NULL,
	"boundary_seq" integer DEFAULT 0 NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"holder" text,
	"heartbeat_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"resume_state" jsonb,
	"billing_source" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "agent_runs_status_check" CHECK ("agent_runs"."status" in ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'interrupted')),
	CONSTRAINT "agent_runs_seq_check" CHECK ("agent_runs"."boundary_seq" <= "agent_runs"."last_seq")
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"segment" integer NOT NULL,
	"kind" text DEFAULT 'chunk' NOT NULL,
	"chunk" jsonb,
	"transient" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_events_run_id_seq_pk" PRIMARY KEY("run_id","seq"),
	CONSTRAINT "run_events_kind_check" CHECK ("run_events"."kind" in ('chunk', 'segment-end'))
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_routine_run_id_routine_runs_id_fk" FOREIGN KEY ("routine_run_id") REFERENCES "public"."routine_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_message_idx" ON "agent_runs" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_active_conversation_idx" ON "agent_runs" USING btree ("conversation_id") WHERE "agent_runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "agent_runs_user_active_idx" ON "agent_runs" USING btree ("user_id") WHERE "agent_runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "agent_runs_conversation_idx" ON "agent_runs" USING btree ("conversation_id","updated_at");--> statement-breakpoint
CREATE INDEX "agent_runs_open_idx" ON "agent_runs" USING btree ("status","heartbeat_at") WHERE "agent_runs"."status" in ('queued', 'running', 'waiting');--> statement-breakpoint
CREATE INDEX "agent_runs_finished_idx" ON "agent_runs" USING btree ("finished_at");--> statement-breakpoint
CREATE INDEX "agent_runs_routine_idx" ON "agent_runs" USING btree ("routine_run_id");