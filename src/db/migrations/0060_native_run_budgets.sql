CREATE TABLE "native_run_budget_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"root_message_id" text NOT NULL,
	"run_id" text,
	"app_id" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"purpose" text NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"input_reserved" bigint NOT NULL,
	"output_reserved" bigint NOT NULL,
	"cost_reserved_micros" bigint NOT NULL,
	"input_tokens" bigint,
	"output_tokens" bigint,
	"cost_micros" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "native_budget_attempt_nonnegative" CHECK ("native_run_budget_attempts"."input_reserved" >= 0 and "native_run_budget_attempts"."output_reserved" >= 0 and "native_run_budget_attempts"."cost_reserved_micros" >= 0 and ("native_run_budget_attempts"."input_tokens" is null or "native_run_budget_attempts"."input_tokens" >= 0) and ("native_run_budget_attempts"."output_tokens" is null or "native_run_budget_attempts"."output_tokens" >= 0) and ("native_run_budget_attempts"."cost_micros" is null or "native_run_budget_attempts"."cost_micros" >= 0)),
	CONSTRAINT "native_budget_attempt_state" CHECK ("native_run_budget_attempts"."state" in ('reserved', 'dispatched', 'uncertain', 'settled', 'released'))
);
--> statement-breakpoint
CREATE TABLE "native_run_budgets" (
	"root_message_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"policy" jsonb NOT NULL,
	"used_tokens" bigint DEFAULT 0 NOT NULL,
	"reserved_tokens" bigint DEFAULT 0 NOT NULL,
	"used_cost_micros" bigint DEFAULT 0 NOT NULL,
	"reserved_cost_micros" bigint DEFAULT 0 NOT NULL,
	"exhausted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_run_budget_nonnegative" CHECK ("native_run_budgets"."used_tokens" >= 0 and "native_run_budgets"."reserved_tokens" >= 0 and "native_run_budgets"."used_cost_micros" >= 0 and "native_run_budgets"."reserved_cost_micros" >= 0)
);
--> statement-breakpoint
ALTER TABLE "native_run_budget_attempts" ADD CONSTRAINT "native_run_budget_attempts_root_message_id_native_run_budgets_root_message_id_fk" FOREIGN KEY ("root_message_id") REFERENCES "public"."native_run_budgets"("root_message_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_run_budgets" ADD CONSTRAINT "native_run_budgets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "native_budget_attempts_root_idx" ON "native_run_budget_attempts" USING btree ("root_message_id");