CREATE TABLE "docker_hermes_enrollments" (
  "user_id" text PRIMARY KEY CONSTRAINT "docker_hermes_enrollments_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE CASCADE,
  "enabled" boolean NOT NULL DEFAULT false,
  "cleanup" text NOT NULL DEFAULT 'none',
  "error" text,
  "changed_by" text CONSTRAINT "docker_hermes_enrollments_changed_by_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "docker_hermes_cleanup_check" CHECK ("cleanup" IN ('none', 'pending', 'stopping', 'failed', 'stopped'))
);
-- Deliberately no implicit enrollment or legacy environment import.
