CREATE INDEX "delegated_tasks_origin_conversation_idx" ON "delegated_tasks" USING btree ("origin_conversation_id");--> statement-breakpoint
CREATE INDEX "group_bot_work_conversation_idx" ON "group_bot_work" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "hosted_search_budgets_conversation_idx" ON "hosted_search_budgets" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "routine_runs_conversation_idx" ON "routine_runs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "shared_links_conversation_idx" ON "shared_links" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "tool_calls_conversation_idx" ON "tool_calls" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "tool_calls_user_bot_created_idx" ON "tool_calls" USING btree ("user_id","bot_id","created_at");