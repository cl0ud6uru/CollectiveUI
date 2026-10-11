CREATE TABLE "group_bot_work" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "group_bot_work" ADD CONSTRAINT "group_bot_work_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_bot_work" ADD CONSTRAINT "group_bot_work_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_bot_work" ADD CONSTRAINT "group_bot_work_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_bot_work_owner_idx" ON "group_bot_work" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "group_bot_work_expiry_idx" ON "group_bot_work" USING btree ("expires_at");