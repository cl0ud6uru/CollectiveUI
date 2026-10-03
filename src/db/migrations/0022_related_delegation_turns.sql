DROP INDEX "delegated_tasks_conversation_idx";--> statement-breakpoint
DROP INDEX "agent_runs_active_conversation_idx";--> statement-breakpoint
ALTER TABLE "delegated_tasks" ADD COLUMN "turn" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "delegated_tasks" ADD COLUMN "continued_from_task_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "delegated_tasks_conversation_turn_idx" ON "delegated_tasks" USING btree ("child_conversation_id","turn");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_active_conversation_idx" ON "agent_runs" USING btree ("conversation_id") WHERE "agent_runs"."status" in ('running', 'waiting_tasks') or ("agent_runs"."status" = 'queued' and "agent_runs"."execution_mode" <> 'async_delegate');--> statement-breakpoint
ALTER TABLE "delegated_tasks" ADD CONSTRAINT "delegated_tasks_turn_check" CHECK ("delegated_tasks"."turn" >= 1);