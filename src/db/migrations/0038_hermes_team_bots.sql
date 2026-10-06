CREATE TABLE "hermes_team_captures" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"captured_by" text NOT NULL,
	"expected_revision" integer NOT NULL,
	"definition_version" integer NOT NULL,
	"manifest_hash" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hermes_team_chats" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"profile_id" text NOT NULL,
	"mode" text NOT NULL,
	CONSTRAINT "hermes_team_chat_mode_check" CHECK ("hermes_team_chats"."mode" in ('member','admin'))
);
--> statement-breakpoint
CREATE TABLE "hermes_team_definitions" (
	"bot_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"published_revision" integer DEFAULT 0 NOT NULL,
	"model_policy" jsonb NOT NULL,
	"tool_policy" jsonb DEFAULT '{"capabilities":[]}'::jsonb NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hermes_team_definition_version_check" CHECK ("hermes_team_definitions"."version" > 0 and "hermes_team_definitions"."published_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "hermes_team_maintainers" (
	"bot_id" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "hermes_team_maintainers_bot_id_user_id_pk" PRIMARY KEY("bot_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "hermes_team_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"profile_id" text,
	"actor_id" text NOT NULL,
	"request_id" text NOT NULL,
	"kind" text NOT NULL,
	"digest" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hermes_team_operation_kind_check" CHECK ("hermes_team_operations"."kind" in ('provision','publish','update','revoke','resolve','rollback')),
	CONSTRAINT "hermes_team_operation_state_check" CHECK ("hermes_team_operations"."state" in ('pending','complete','needs_attention'))
);
--> statement-breakpoint
CREATE TABLE "hermes_team_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"user_id" text,
	"mode" text NOT NULL,
	"owner_key" text NOT NULL,
	"request_id" text NOT NULL,
	"binding" jsonb,
	"state" text DEFAULT 'preparing' NOT NULL,
	"installed_revision" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hermes_team_profile_mode_check" CHECK (("hermes_team_profiles"."mode" = 'member' and "hermes_team_profiles"."user_id" is not null and "hermes_team_profiles"."owner_key" = "hermes_team_profiles"."user_id") or ("hermes_team_profiles"."mode" = 'admin' and "hermes_team_profiles"."user_id" is null and "hermes_team_profiles"."owner_key" = 'team-admin:' || "hermes_team_profiles"."bot_id")),
	CONSTRAINT "hermes_team_profile_state_check" CHECK ("hermes_team_profiles"."state" in ('preparing','connection_needed','ready','updating','needs_attention','revoked'))
);
--> statement-breakpoint
CREATE TABLE "hermes_team_resource_states" (
	"profile_id" text NOT NULL,
	"package_id" text NOT NULL,
	"installed_hash" text,
	"override" text,
	"conflict_revision" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hermes_team_resource_states_profile_id_package_id_pk" PRIMARY KEY("profile_id","package_id"),
	CONSTRAINT "hermes_team_override_check" CHECK ("hermes_team_resource_states"."override" is null or "hermes_team_resource_states"."override" in ('modified','deleted','keep'))
);
--> statement-breakpoint
CREATE TABLE "hermes_team_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"revision" integer NOT NULL,
	"manifest_hash" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"release_note" text NOT NULL,
	"published_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hermes_team_revision_positive_check" CHECK ("hermes_team_revisions"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "hermes_team_run_attribution" (
	"run_id" text PRIMARY KEY NOT NULL,
	"profile_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"definition_version" integer NOT NULL,
	"team_revision" integer,
	"mode" text NOT NULL,
	"model_source" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "hermes_team" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hermes_team_captures" ADD CONSTRAINT "hermes_team_captures_bot_id_hermes_team_definitions_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."hermes_team_definitions"("bot_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_captures" ADD CONSTRAINT "hermes_team_captures_captured_by_users_id_fk" FOREIGN KEY ("captured_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_chats" ADD CONSTRAINT "hermes_team_chats_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_chats" ADD CONSTRAINT "hermes_team_chats_profile_id_hermes_team_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."hermes_team_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_definitions" ADD CONSTRAINT "hermes_team_definitions_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_definitions" ADD CONSTRAINT "hermes_team_definitions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_maintainers" ADD CONSTRAINT "hermes_team_maintainers_bot_id_hermes_team_definitions_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."hermes_team_definitions"("bot_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_maintainers" ADD CONSTRAINT "hermes_team_maintainers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_operations" ADD CONSTRAINT "hermes_team_operations_bot_id_hermes_team_definitions_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."hermes_team_definitions"("bot_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_operations" ADD CONSTRAINT "hermes_team_operations_profile_id_hermes_team_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."hermes_team_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_operations" ADD CONSTRAINT "hermes_team_operations_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_profiles" ADD CONSTRAINT "hermes_team_profiles_bot_id_hermes_team_definitions_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."hermes_team_definitions"("bot_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_profiles" ADD CONSTRAINT "hermes_team_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_resource_states" ADD CONSTRAINT "hermes_team_resource_states_profile_id_hermes_team_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."hermes_team_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_revisions" ADD CONSTRAINT "hermes_team_revisions_bot_id_hermes_team_definitions_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."hermes_team_definitions"("bot_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_revisions" ADD CONSTRAINT "hermes_team_revisions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_run_attribution" ADD CONSTRAINT "hermes_team_run_attribution_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_run_attribution" ADD CONSTRAINT "hermes_team_run_attribution_profile_id_hermes_team_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."hermes_team_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_team_operation_receipt_idx" ON "hermes_team_operations" USING btree ("bot_id","actor_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_team_profile_member_idx" ON "hermes_team_profiles" USING btree ("bot_id","user_id") WHERE "hermes_team_profiles"."mode" = 'member';--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_team_profile_admin_idx" ON "hermes_team_profiles" USING btree ("bot_id") WHERE "hermes_team_profiles"."mode" = 'admin';--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_team_revision_idx" ON "hermes_team_revisions" USING btree ("bot_id","revision");