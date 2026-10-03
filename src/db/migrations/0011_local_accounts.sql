CREATE TABLE "auth_throttle" (
	"key" text PRIMARY KEY NOT NULL,
	"attempts" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_auth_bootstrap" (
	"id" integer PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_auth_bootstrap_singleton" CHECK ("local_auth_bootstrap"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "local_credentials" (
	"user_id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"temporary_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_credentials_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "local_login_aliases" (
	"login" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_upn_unique";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "identity_realm" text DEFAULT 'directory' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "session_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "local_credentials" ADD CONSTRAINT "local_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_login_aliases" ADD CONSTRAINT "local_login_aliases_user_id_local_credentials_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."local_credentials"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_throttle_expiry_idx" ON "auth_throttle" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_realm_upn_idx" ON "users" USING btree ("identity_realm","upn");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_identity_realm_check" CHECK (("users"."identity_realm" = 'local' and "users"."auth_source" = 'local') or ("users"."identity_realm" = 'directory' and "users"."auth_source" in ('entra', 'ldap')));