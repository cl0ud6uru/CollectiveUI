CREATE TABLE "mobile_auth_codes" (
	"hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_version" integer NOT NULL,
	"auth_provider" text,
	"code_challenge" text NOT NULL,
	"device_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mobile_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"device_name" text NOT NULL,
	"session_version" integer NOT NULL,
	"auth_provider" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "mobile_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "mobile_auth_codes" ADD CONSTRAINT "mobile_auth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_sessions" ADD CONSTRAINT "mobile_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mobile_auth_codes_expiry_idx" ON "mobile_auth_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mobile_sessions_user_idx" ON "mobile_sessions" USING btree ("user_id");