CREATE TABLE "provider_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"provider" text DEFAULT 'openai' NOT NULL,
	"base_url" text,
	"organization" text,
	"project" text,
	"secret_enc" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_connections_provider_check" CHECK ("provider_connections"."provider" = 'openai')
);
--> statement-breakpoint
ALTER TABLE "ai_apps" ADD COLUMN "provider_connection_id" text;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_apps" ADD CONSTRAINT "ai_apps_provider_connection_id_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_apps_provider_connection_idx" ON "ai_apps" USING btree ("provider_connection_id");--> statement-breakpoint
ALTER TABLE "ai_apps" ADD CONSTRAINT "ai_apps_provider_connection_check" CHECK ("ai_apps"."provider_connection_id" is null or ("ai_apps"."provider" = 'openai' and "ai_apps"."credential_mode" = 'org' and "ai_apps"."api_key_enc" is null));