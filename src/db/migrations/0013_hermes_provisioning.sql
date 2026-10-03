CREATE TABLE "hermes_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"boundary_id" text NOT NULL,
	"dashboard_url" text NOT NULL,
	"runs_url" text NOT NULL,
	"protocol" text NOT NULL,
	"expected_version" text NOT NULL,
	"expected_display_version" text NOT NULL,
	"provider" text NOT NULL,
	"secret_enc" text NOT NULL,
	"quota" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hermes_connections_quota_check" CHECK ("hermes_connections"."quota" between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "hermes_provisions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"app_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"profile" text NOT NULL,
	"key_slot" integer NOT NULL,
	"spec_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"create_attempted" boolean DEFAULT false NOT NULL,
	"lease" text,
	"retry_after" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hermes_provisions_status_check" CHECK ("hermes_provisions"."status" in ('pending', 'provisioning', 'ready', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "hermes_run_contexts" ADD COLUMN "provision_id" text;--> statement-breakpoint
ALTER TABLE "hermes_connections" ADD CONSTRAINT "hermes_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_provisions" ADD CONSTRAINT "hermes_provisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_provisions" ADD CONSTRAINT "hermes_provisions_connection_id_hermes_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."hermes_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_connections_user_idx" ON "hermes_connections" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_connections_boundary_idx" ON "hermes_connections" USING btree ("boundary_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_connections_dashboard_idx" ON "hermes_connections" USING btree ("dashboard_url");--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_connections_runs_idx" ON "hermes_connections" USING btree ("runs_url");--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_provisions_user_bot_idx" ON "hermes_provisions" USING btree ("user_id","bot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_provisions_slot_idx" ON "hermes_provisions" USING btree ("connection_id","key_slot");--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_provisions_profile_idx" ON "hermes_provisions" USING btree ("connection_id","profile");