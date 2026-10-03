CREATE TABLE "chatgpt_device_logins" (
	"user_id" text PRIMARY KEY NOT NULL,
	"device_auth_enc" text NOT NULL,
	"user_code" text NOT NULL,
	"interval_sec" integer NOT NULL,
	"next_poll_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"secret_enc" text NOT NULL,
	"account_id" text NOT NULL,
	"plan_type" text,
	"email" text,
	"external_subject" text,
	"residency" text,
	"is_fedramp" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"last_refresh_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"rate_limits" jsonb,
	"rate_limits_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_credentials_provider_check" CHECK ("user_credentials"."provider" in ('chatgpt')),
	CONSTRAINT "user_credentials_status_check" CHECK ("user_credentials"."status" in ('active', 'needs_reauth'))
);
--> statement-breakpoint
ALTER TABLE "chatgpt_device_logins" ADD CONSTRAINT "chatgpt_device_logins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_credentials" ADD CONSTRAINT "user_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_credentials_user_provider_idx" ON "user_credentials" USING btree ("user_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "user_credentials_subject_idx" ON "user_credentials" USING btree ("provider","account_id","external_subject") WHERE "user_credentials"."external_subject" is not null;