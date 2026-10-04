CREATE TABLE "docker_hermes_enrollments" (
	"user_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"cleanup" text DEFAULT 'none' NOT NULL,
	"error" text,
	"changed_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docker_hermes_cleanup_check" CHECK ("docker_hermes_enrollments"."cleanup" in ('none', 'pending', 'stopping', 'failed', 'stopped'))
);
--> statement-breakpoint
ALTER TABLE "docker_hermes_enrollments" ADD CONSTRAINT "docker_hermes_enrollments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_hermes_enrollments" ADD CONSTRAINT "docker_hermes_enrollments_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;