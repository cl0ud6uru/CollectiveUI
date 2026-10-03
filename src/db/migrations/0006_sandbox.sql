CREATE TABLE "sandboxes" (
	"user_id" text PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"delete_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandboxes_ref_unique" UNIQUE("ref")
);
--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;