CREATE TABLE "docker_hermes_enrollments" (
  "user_id" text PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "enabled" boolean NOT NULL DEFAULT false,
  "cleanup" text NOT NULL DEFAULT 'none',
  "error" text,
  "changed_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "docker_hermes_cleanup_check" CHECK ("cleanup" IN ('none', 'pending', 'stopping', 'failed', 'stopped'))
);
-- Deliberately no implicit enrollment or legacy environment import.
