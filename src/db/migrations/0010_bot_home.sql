ALTER TABLE "conversations" ADD COLUMN "is_bot_home" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "home_successor_id" text;--> statement-breakpoint
CREATE INDEX "agent_runs_user_bot_activity_idx" ON "agent_runs" USING btree ("user_id","bot_id","updated_at");--> statement-breakpoint
CREATE INDEX "conversations_user_bot_idx" ON "conversations" USING btree ("user_id","bot_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_bot_home_idx" ON "conversations" USING btree ("user_id","bot_id") WHERE "conversations"."is_bot_home" and "conversations"."bot_id" is not null;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_bot_home_check" CHECK (not "conversations"."is_bot_home" or (not "conversations"."is_group" and not "conversations"."archived" and "conversations"."source" = 'chat' and "conversations"."app_id" is null));