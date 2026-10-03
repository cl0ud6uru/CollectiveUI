CREATE TABLE "bot_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"created_by" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "conversation_bots" (
	"conversation_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "conversation_bots_conversation_id_bot_id_pk" PRIMARY KEY("conversation_id","bot_id")
);
--> statement-breakpoint
CREATE TABLE "user_bot_prefs" (
	"user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_bot_prefs_user_id_bot_id_pk" PRIMARY KEY("user_id","bot_id")
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "is_group" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_templates" ADD CONSTRAINT "bot_templates_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_templates" ADD CONSTRAINT "bot_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_bots" ADD CONSTRAINT "conversation_bots_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_bots" ADD CONSTRAINT "conversation_bots_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_bot_prefs" ADD CONSTRAINT "user_bot_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_bot_prefs" ADD CONSTRAINT "user_bot_prefs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;