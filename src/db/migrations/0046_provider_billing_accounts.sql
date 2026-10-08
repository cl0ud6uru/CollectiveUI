CREATE TABLE "provider_billing_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"organization" text NOT NULL,
	"admin_key_enc" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"show_health_bar" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"snapshot" jsonb,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "provider_connection_id" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "provider_organization" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "provider_project" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "billing_route" text;--> statement-breakpoint
ALTER TABLE "provider_billing_accounts" ADD CONSTRAINT "provider_billing_accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;