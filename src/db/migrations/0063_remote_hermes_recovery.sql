CREATE TABLE "remote_hermes_recoveries" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"session_id" text NOT NULL,
	"binding" jsonb NOT NULL,
	"claimed_ownership" jsonb,
	"completed_ownership" jsonb,
	"native_requested_at" timestamp with time zone,
	"state" text NOT NULL,
	"receipt" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remote_hermes_recovery_state_check" CHECK ("remote_hermes_recoveries"."state" in ('prepared','pending','uncertain','applied','superseded')),
	CONSTRAINT "remote_hermes_recovery_binding_bound" CHECK (jsonb_typeof("remote_hermes_recoveries"."binding") = 'object' and octet_length("remote_hermes_recoveries"."binding"::text) <= 16000),
	CONSTRAINT "remote_hermes_recovery_ownership_bound" CHECK (("remote_hermes_recoveries"."claimed_ownership" is null or (jsonb_typeof("remote_hermes_recoveries"."claimed_ownership") = 'object' and octet_length("remote_hermes_recoveries"."claimed_ownership"::text) <= 16000)) and ("remote_hermes_recoveries"."completed_ownership" is null or (jsonb_typeof("remote_hermes_recoveries"."completed_ownership") = 'object' and octet_length("remote_hermes_recoveries"."completed_ownership"::text) <= 16000))),
	CONSTRAINT "remote_hermes_recovery_terminal_check" CHECK ("remote_hermes_recoveries"."state" <> 'applied' or ("remote_hermes_recoveries"."confirmed_at" is not null and "remote_hermes_recoveries"."native_requested_at" is not null and "remote_hermes_recoveries"."receipt"->>'state' = 'drained' and "remote_hermes_recoveries"."receipt"->>'reason' = 'drained' and "remote_hermes_recoveries"."receipt"->>'recovery_id' = "remote_hermes_recoveries"."id" and "remote_hermes_recoveries"."completed_ownership"#>>'{nativeFence,phase}' = 'full' and "remote_hermes_recoveries"."completed_ownership"#>>'{nativeFence,recoveryId}' = "remote_hermes_recoveries"."id") is true),
	CONSTRAINT "remote_hermes_recovery_receipt_bound" CHECK ("remote_hermes_recoveries"."receipt" is null or (jsonb_typeof("remote_hermes_recoveries"."receipt") = 'object' and octet_length("remote_hermes_recoveries"."receipt"::text) <= 24000))
);
--> statement-breakpoint
ALTER TABLE "remote_hermes_recoveries" ADD CONSTRAINT "remote_hermes_recoveries_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_hermes_recoveries" ADD CONSTRAINT "remote_hermes_recoveries_connection_id_remote_hermes_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."remote_hermes_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_hermes_recoveries" ADD CONSTRAINT "remote_hermes_recoveries_session_id_remote_hermes_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."remote_hermes_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "remote_hermes_recovery_active_idx" ON "remote_hermes_recoveries" USING btree ("session_id") WHERE "remote_hermes_recoveries"."state" in ('prepared','pending','uncertain');