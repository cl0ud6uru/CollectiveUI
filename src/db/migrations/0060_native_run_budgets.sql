CREATE TABLE "native_run_budgets" (
  "root_message_id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "policy" jsonb NOT NULL,
  "used_tokens" bigint DEFAULT 0 NOT NULL,
  "reserved_tokens" bigint DEFAULT 0 NOT NULL,
  "used_cost_micros" bigint DEFAULT 0 NOT NULL,
  "reserved_cost_micros" bigint DEFAULT 0 NOT NULL,
  "exhausted" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "native_run_budget_nonnegative" CHECK ("used_tokens" >= 0 and "reserved_tokens" >= 0 and "used_cost_micros" >= 0 and "reserved_cost_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "native_run_budget_attempts" (
  "id" text PRIMARY KEY NOT NULL,
  "root_message_id" text NOT NULL REFERENCES "native_run_budgets"("root_message_id") ON DELETE cascade,
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
  CONSTRAINT "native_budget_attempt_nonnegative" CHECK ("input_reserved" >= 0 and "output_reserved" >= 0 and "cost_reserved_micros" >= 0 and ("input_tokens" is null or "input_tokens" >= 0) and ("output_tokens" is null or "output_tokens" >= 0) and ("cost_micros" is null or "cost_micros" >= 0)),
  CONSTRAINT "native_budget_attempt_state" CHECK ("state" in ('reserved', 'dispatched', 'uncertain', 'settled', 'released'))
);
--> statement-breakpoint
CREATE INDEX "native_budget_attempts_root_idx" ON "native_run_budget_attempts" ("root_message_id");
