ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_status_check";--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_execution_mode_check";--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_inline_check";--> statement-breakpoint
DROP INDEX "agent_runs_active_conversation_idx";--> statement-breakpoint
DROP INDEX "agent_runs_open_idx";--> statement-breakpoint
ALTER TABLE "delegated_tasks" ADD COLUMN "mode" text DEFAULT 'sync' NOT NULL;--> statement-breakpoint
ALTER TABLE "delegated_tasks" ADD COLUMN "parent_segment" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delegated_tasks" ADD COLUMN "notified_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "delegated_tasks_async_pending_idx" ON "delegated_tasks" USING btree ("parent_run_id","parent_segment") WHERE "delegated_tasks"."mode" = 'async' and "delegated_tasks"."returned_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_active_conversation_idx" ON "agent_runs" USING btree ("conversation_id") WHERE "agent_runs"."status" in ('queued', 'running', 'waiting_tasks');--> statement-breakpoint
CREATE INDEX "agent_runs_open_idx" ON "agent_runs" USING btree ("status","heartbeat_at") WHERE "agent_runs"."status" in ('queued', 'running', 'waiting', 'waiting_tasks');--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_async_check" CHECK ("agent_runs"."execution_mode" <> 'async_delegate' or ("agent_runs"."routine_run_id" is null and "agent_runs"."background" and "agent_runs"."status" <> 'waiting'));--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_status_check" CHECK ("agent_runs"."status" in ('queued', 'running', 'waiting', 'waiting_tasks', 'succeeded', 'failed', 'cancelled', 'interrupted'));--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_execution_mode_check" CHECK ("agent_runs"."execution_mode" in ('worker', 'inline_delegate', 'async_delegate'));--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_inline_check" CHECK ("agent_runs"."execution_mode" <> 'inline_delegate' or ("agent_runs"."status" not in ('queued', 'waiting', 'waiting_tasks') and "agent_runs"."routine_run_id" is null and "agent_runs"."segment" = 0));--> statement-breakpoint
ALTER TABLE "delegated_tasks" ADD CONSTRAINT "delegated_tasks_mode_check" CHECK ("delegated_tasks"."mode" in ('sync', 'async'));--> statement-breakpoint
ALTER TABLE "delegated_tasks" ADD CONSTRAINT "delegated_tasks_segment_check" CHECK ("delegated_tasks"."parent_segment" >= 0);