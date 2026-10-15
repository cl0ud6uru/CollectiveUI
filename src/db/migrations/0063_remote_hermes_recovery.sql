CREATE TABLE "remote_hermes_recoveries" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "connection_id" text NOT NULL REFERENCES "remote_hermes_connections"("id") ON DELETE CASCADE,
  "session_id" text NOT NULL REFERENCES "remote_hermes_sessions"("id") ON DELETE CASCADE,
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
  CONSTRAINT "remote_hermes_recovery_state_check" CHECK ("state" in ('prepared','pending','uncertain','applied','superseded')),
  CONSTRAINT "remote_hermes_recovery_binding_bound" CHECK (jsonb_typeof("binding") = 'object' and octet_length("binding"::text) <= 16000),
  CONSTRAINT "remote_hermes_recovery_ownership_bound" CHECK (("claimed_ownership" is null or (jsonb_typeof("claimed_ownership") = 'object' and octet_length("claimed_ownership"::text) <= 16000)) and ("completed_ownership" is null or (jsonb_typeof("completed_ownership") = 'object' and octet_length("completed_ownership"::text) <= 16000))),
  CONSTRAINT "remote_hermes_recovery_terminal_check" CHECK ("state" <> 'applied' or ("confirmed_at" is not null and "native_requested_at" is not null and "receipt"->>'state' = 'drained' and "receipt"->>'reason' = 'drained' and "receipt"->>'recovery_id' = "id" and "completed_ownership"#>>'{nativeFence,phase}' = 'full' and "completed_ownership"#>>'{nativeFence,recoveryId}' = "id") is true),
  CONSTRAINT "remote_hermes_recovery_receipt_bound" CHECK ("receipt" is null or (jsonb_typeof("receipt") = 'object' and octet_length("receipt"::text) <= 24000))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "remote_hermes_recovery_active_idx" ON "remote_hermes_recoveries" ("session_id") WHERE "state" in ('prepared','pending','uncertain');
