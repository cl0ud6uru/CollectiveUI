CREATE TABLE "codex_bot_configs" (
	"bot_id" text PRIMARY KEY NOT NULL,
	"policy" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "codex_runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"runtime_id" text NOT NULL,
	"binding" text NOT NULL,
	"funding" text NOT NULL,
	"thread_id" text,
	"turn_id" text,
	"phase" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "codex_runs_funding_check" CHECK ("codex_runs"."funding" in ('api', 'chatgpt_subscription')),
	CONSTRAINT "codex_runs_phase_check" CHECK ("codex_runs"."phase" in ('reserved', 'ready', 'dispatching', 'running', 'terminal', 'stop_unconfirmed'))
);
--> statement-breakpoint
ALTER TABLE "codex_bot_configs" ADD CONSTRAINT "codex_bot_configs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "codex_runs_recovery_idx" ON "codex_runs" USING btree ("phase","updated_at");--> statement-breakpoint
CREATE INDEX "codex_runs_owner_idx" ON "codex_runs" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "codex_runs_owner_active_idx" ON "codex_runs" USING btree ("user_id") WHERE "codex_runs"."phase" <> 'terminal';