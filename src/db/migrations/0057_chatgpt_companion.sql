CREATE TABLE "chatgpt_companion_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_version" integer NOT NULL,
	"host_id" text NOT NULL,
	"origin" text NOT NULL,
	"launch_hash" text NOT NULL,
	"return_hash" text,
	"payload_enc" text NOT NULL,
	"enable_codex" boolean DEFAULT false NOT NULL,
	"custody_hash" text,
	"state" text DEFAULT 'created' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"recovery_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chatgpt_companion_state_check" CHECK ("chatgpt_companion_attempts"."state" in ('created', 'paired', 'receiving', 'complete', 'cancelled', 'needs_attention', 'expired')),
	CONSTRAINT "chatgpt_companion_identity_check" CHECK ("chatgpt_companion_attempts"."session_version" >= 0 and length("chatgpt_companion_attempts"."id") = 36 and length("chatgpt_companion_attempts"."host_id") between 1 and 256 and length("chatgpt_companion_attempts"."origin") between 1 and 2048),
	CONSTRAINT "chatgpt_companion_secret_check" CHECK ("chatgpt_companion_attempts"."launch_hash" ~ '^[a-f0-9]{64}$' and ("chatgpt_companion_attempts"."return_hash" is null or "chatgpt_companion_attempts"."return_hash" ~ '^[a-f0-9]{64}$') and ("chatgpt_companion_attempts"."custody_hash" is null or "chatgpt_companion_attempts"."custody_hash" ~ '^[a-f0-9]{64}$') and "chatgpt_companion_attempts"."payload_enc" like 'v2.%' and octet_length("chatgpt_companion_attempts"."payload_enc") <= 64000),
	CONSTRAINT "chatgpt_companion_expiry_check" CHECK ("chatgpt_companion_attempts"."expires_at" > "chatgpt_companion_attempts"."created_at" and "chatgpt_companion_attempts"."expires_at" <= "chatgpt_companion_attempts"."created_at" + interval '10 minutes' and "chatgpt_companion_attempts"."recovery_until" >= "chatgpt_companion_attempts"."expires_at" and "chatgpt_companion_attempts"."recovery_until" <= "chatgpt_companion_attempts"."created_at" + interval '1 day')
);
--> statement-breakpoint
ALTER TABLE "chatgpt_companion_attempts" ADD CONSTRAINT "chatgpt_companion_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chatgpt_companion_open_owner_idx" ON "chatgpt_companion_attempts" USING btree ("user_id") WHERE "chatgpt_companion_attempts"."state" in ('created', 'paired', 'receiving');