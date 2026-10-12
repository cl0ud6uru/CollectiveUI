CREATE TABLE "web_sessions" (
	"session_id_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_version" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "web_sessions_version_check" CHECK ("web_sessions"."session_version" >= 0),
	CONSTRAINT "web_sessions_hash_check" CHECK ("web_sessions"."session_id_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "web_sessions_owner_idx" ON "web_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "web_sessions_expiry_idx" ON "web_sessions" USING btree ("expires_at");