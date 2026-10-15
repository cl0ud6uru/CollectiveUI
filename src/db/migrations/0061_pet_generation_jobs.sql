CREATE TABLE "pet_generation_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"provider_connection_id" text NOT NULL,
	"model_id" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text NOT NULL,
	"credit" text DEFAULT 'AI generated with OpenAI' NOT NULL,
	"reference" bytea,
	"appearance" bytea,
	"appearance_state" text DEFAULT 'needs_consent' NOT NULL,
	"appearance_attempt" integer DEFAULT 0 NOT NULL,
	"appearance_consent_at" timestamp with time zone,
	"appearance_approved_at" timestamp with time zone,
	"appearance_input_tokens" integer,
	"appearance_output_tokens" integer,
	"appearance_error_code" text,
	"build_consent_at" timestamp with time zone,
	"preview" bytea,
	"catalog_pet_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pet_generation_jobs_appearance_state_check" CHECK ("pet_generation_jobs"."appearance_state" in ('needs_consent', 'queued', 'running', 'succeeded', 'failed', 'uncertain', 'approved')),
	CONSTRAINT "pet_generation_jobs_reference_size" CHECK ("pet_generation_jobs"."reference" is null or octet_length("pet_generation_jobs"."reference") between 1 and 1048576),
	CONSTRAINT "pet_generation_jobs_appearance_size" CHECK ("pet_generation_jobs"."appearance" is null or octet_length("pet_generation_jobs"."appearance") between 1 and 4194304),
	CONSTRAINT "pet_generation_jobs_preview_size" CHECK ("pet_generation_jobs"."preview" is null or octet_length("pet_generation_jobs"."preview") between 1 and 4194304),
	CONSTRAINT "pet_generation_jobs_usage_nonnegative" CHECK (("pet_generation_jobs"."appearance_input_tokens" is null or "pet_generation_jobs"."appearance_input_tokens" >= 0) and ("pet_generation_jobs"."appearance_output_tokens" is null or "pet_generation_jobs"."appearance_output_tokens" >= 0))
);
--> statement-breakpoint
CREATE TABLE "pet_generation_slots" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"slot_key" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"prompt" text NOT NULL,
	"consent_version" integer DEFAULT 1 NOT NULL,
	"consent_summary" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"consent_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"image" bytea,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_micros" bigint,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pet_generation_slots_status_check" CHECK ("pet_generation_slots"."status" in ('queued', 'running', 'succeeded', 'failed', 'uncertain')),
	CONSTRAINT "pet_generation_slots_consent_version_check" CHECK ("pet_generation_slots"."consent_version" > 0),
	CONSTRAINT "pet_generation_slots_image_size" CHECK ("pet_generation_slots"."image" is null or octet_length("pet_generation_slots"."image") between 1 and 4194304),
	CONSTRAINT "pet_generation_slots_usage_nonnegative" CHECK (("pet_generation_slots"."input_tokens" is null or "pet_generation_slots"."input_tokens" >= 0) and ("pet_generation_slots"."output_tokens" is null or "pet_generation_slots"."output_tokens" >= 0) and ("pet_generation_slots"."cost_micros" is null or "pet_generation_slots"."cost_micros" >= 0))
);
--> statement-breakpoint
ALTER TABLE "pet_generation_jobs" ADD CONSTRAINT "pet_generation_jobs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pet_generation_jobs" ADD CONSTRAINT "pet_generation_jobs_catalog_pet_id_pet_catalog_id_fk" FOREIGN KEY ("catalog_pet_id") REFERENCES "public"."pet_catalog"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pet_generation_slots" ADD CONSTRAINT "pet_generation_slots_job_id_pet_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."pet_generation_jobs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "pet_generation_jobs_owner_idx" ON "pet_generation_jobs" USING btree ("owner_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "pet_generation_slots_job_slot_attempt_idx" ON "pet_generation_slots" USING btree ("job_id","slot_key","attempt");
--> statement-breakpoint
CREATE INDEX "pet_generation_slots_job_status_idx" ON "pet_generation_slots" USING btree ("job_id","status");
