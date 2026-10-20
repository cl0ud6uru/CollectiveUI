CREATE TABLE "architect_provider_connection_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_version" integer NOT NULL,
	"bot_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text,
	"organization" text,
	"project" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"connection_id" text,
	CONSTRAINT "architect_provider_drafts_session_check" CHECK ("architect_provider_connection_drafts"."session_version" >= 0),
	CONSTRAINT "architect_provider_drafts_provider_check" CHECK ("architect_provider_connection_drafts"."provider" in ('openai', 'openai-compatible', 'openrouter')),
	CONSTRAINT "architect_provider_drafts_name_check" CHECK (length(trim("architect_provider_connection_drafts"."name")) between 1 and 80),
	CONSTRAINT "architect_provider_drafts_consumed_check" CHECK (("architect_provider_connection_drafts"."consumed_at" is null) = ("architect_provider_connection_drafts"."connection_id" is null))
);
--> statement-breakpoint
ALTER TABLE "architect_provider_connection_drafts" ADD CONSTRAINT "architect_provider_connection_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "architect_provider_connection_drafts" ADD CONSTRAINT "architect_provider_connection_drafts_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "architect_provider_connection_drafts" ADD CONSTRAINT "architect_provider_connection_drafts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "architect_provider_drafts_owner_expiry_idx" ON "architect_provider_connection_drafts" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "architect_provider_drafts_context_idx" ON "architect_provider_connection_drafts" USING btree ("bot_id","conversation_id");