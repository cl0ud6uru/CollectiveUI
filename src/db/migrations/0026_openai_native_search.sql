CREATE TABLE "hosted_search_budgets" (
	"message_id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"max_calls" integer NOT NULL,
	"reserved_calls" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "hosted_search_budget_check" CHECK ("hosted_search_budgets"."max_calls" between 1 and 10 and "hosted_search_budgets"."reserved_calls" between 0 and "hosted_search_budgets"."max_calls")
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "native_search_mode" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "hosted_search_calls" integer;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "search_tool_cost_estimate_micros" bigint;--> statement-breakpoint
ALTER TABLE "hosted_search_budgets" ADD CONSTRAINT "hosted_search_budgets_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;