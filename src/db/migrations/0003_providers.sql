CREATE TABLE "usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text,
	"conversation_id" text,
	"message_id" text,
	"tool_call_id" text,
	"run_id" text,
	"bot_id" text,
	"app_id" text,
	"provider_kind" text NOT NULL,
	"model" text NOT NULL,
	"purpose" text NOT NULL,
	"billing_source" text NOT NULL,
	"credential_id" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"reasoning_tokens" integer,
	"cost_micros" bigint
);
--> statement-breakpoint
ALTER TABLE "ai_apps" ALTER COLUMN "base_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_apps" ADD COLUMN "kind" text DEFAULT 'model' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_apps" ADD COLUMN "provider" text DEFAULT 'openai-compatible' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_apps" ADD COLUMN "provider_config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_apps" ADD COLUMN "credential_mode" text DEFAULT 'org' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "billing_source" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "provider_kind" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "app_id" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_events_created_idx" ON "usage_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "usage_events_user_idx" ON "usage_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_events_conversation_idx" ON "usage_events" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "usage_events_message_idx" ON "usage_events" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "usage_events_app_idx" ON "usage_events" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "usage_events_bot_idx" ON "usage_events" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "messages_app_idx" ON "messages" USING btree ("app_id");--> statement-breakpoint
ALTER TABLE "ai_apps" ADD CONSTRAINT "ai_apps_kind_check" CHECK ("ai_apps"."kind" in ('model', 'runtime'));--> statement-breakpoint
ALTER TABLE "ai_apps" ADD CONSTRAINT "ai_apps_provider_check" CHECK ("ai_apps"."provider" in ('openai-compatible', 'openai', 'azure', 'anthropic', 'bedrock', 'vertex-anthropic', 'chatgpt'));--> statement-breakpoint
ALTER TABLE "ai_apps" ADD CONSTRAINT "ai_apps_credential_mode_check" CHECK ("ai_apps"."credential_mode" in ('org', 'user', 'user_or_org'));--> statement-breakpoint
ALTER TABLE "ai_apps" ADD CONSTRAINT "ai_apps_chatgpt_user_check" CHECK ("ai_apps"."provider" <> 'chatgpt' or "ai_apps"."credential_mode" = 'user');--> statement-breakpoint
ALTER TABLE "ai_apps" ADD CONSTRAINT "ai_apps_base_url_check" CHECK ("ai_apps"."provider" <> 'openai-compatible' or "ai_apps"."base_url" is not null);