CREATE TABLE "codex_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"binding" text NOT NULL,
	"thread_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"decision" text,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "codex_approval_decision_check" CHECK ("codex_approvals"."decision" is null or "codex_approvals"."decision" in ('decline', 'cancel'))
);
--> statement-breakpoint
CREATE TABLE "codex_threads" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"binding" text NOT NULL,
	"app_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"last_message_id" text,
	"token_totals" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_codex_accounts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"credential_binding" text NOT NULL,
	"email" text NOT NULL,
	"workspace_id" text NOT NULL,
	"plan_type" text NOT NULL,
	"connected" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "codex_runs" ADD COLUMN "baseline_turn_id" text;--> statement-breakpoint
ALTER TABLE "codex_threads" ADD CONSTRAINT "codex_threads_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_codex_accounts" ADD CONSTRAINT "personal_codex_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "codex_approvals_run_idx" ON "codex_approvals" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_codex_account_owner_idx" ON "personal_codex_accounts" USING btree (lower("email")) WHERE "personal_codex_accounts"."connected";