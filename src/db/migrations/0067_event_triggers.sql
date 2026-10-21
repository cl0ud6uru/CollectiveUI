CREATE TABLE "trigger_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text NOT NULL,
	"credentials" text,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"installed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trigger_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"connection_id" text,
	"external_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"matched_count" integer DEFAULT 0 NOT NULL,
	"payload" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "trigger_event_id" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "trigger_config" jsonb;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "trigger_provider" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "trigger_connection_id" text;--> statement-breakpoint
ALTER TABLE "trigger_connections" ADD CONSTRAINT "trigger_connections_installed_by_users_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_events" ADD CONSTRAINT "trigger_events_connection_id_trigger_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."trigger_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trigger_connections_provider_external_idx" ON "trigger_connections" USING btree ("provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trigger_events_provider_external_idx" ON "trigger_events" USING btree ("provider","external_event_id");--> statement-breakpoint
CREATE INDEX "trigger_events_received_idx" ON "trigger_events" USING btree ("received_at");--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_trigger_connection_id_trigger_connections_id_fk" FOREIGN KEY ("trigger_connection_id") REFERENCES "public"."trigger_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "routine_runs_trigger_event_idx" ON "routine_runs" USING btree ("routine_id","trigger_event_id") WHERE "routine_runs"."trigger_event_id" is not null;--> statement-breakpoint
CREATE INDEX "routines_event_idx" ON "routines" USING btree ("trigger_provider","trigger_connection_id") WHERE "routines"."enabled" and "routines"."trigger_type" = 'event';--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_trigger_type_check" CHECK ("routines"."trigger_type" in ('cron', 'webhook', 'event'));