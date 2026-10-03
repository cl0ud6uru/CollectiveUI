CREATE TABLE "auth_flows" (
	"hash" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"purpose" text NOT NULL,
	"binding_hash" text NOT NULL,
	"user_id" text,
	"session_version" integer,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_passkeys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "local_passkeys_counter_check" CHECK ("local_passkeys"."counter" >= 0),
	CONSTRAINT "local_passkeys_device_type_check" CHECK ("local_passkeys"."device_type" in ('singleDevice', 'multiDevice'))
);
--> statement-breakpoint
CREATE TABLE "local_recovery_codes" (
	"hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_security" (
	"user_id" text PRIMARY KEY NOT NULL,
	"user_handle" text NOT NULL,
	"totp_secret_enc" text,
	"totp_last_step" bigint,
	CONSTRAINT "local_security_user_handle_unique" UNIQUE("user_handle")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auth_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_flows" ADD CONSTRAINT "auth_flows_user_id_local_credentials_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."local_credentials"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_passkeys" ADD CONSTRAINT "local_passkeys_user_id_local_security_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."local_security"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_recovery_codes" ADD CONSTRAINT "local_recovery_codes_user_id_local_security_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."local_security"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_security" ADD CONSTRAINT "local_security_user_id_local_credentials_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."local_credentials"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_flows_expiry_idx" ON "auth_flows" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_flows_user_idx" ON "auth_flows" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "local_passkeys_user_idx" ON "local_passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "local_recovery_user_idx" ON "local_recovery_codes" USING btree ("user_id");