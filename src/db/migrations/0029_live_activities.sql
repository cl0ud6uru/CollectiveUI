CREATE TABLE "live_activities" (
	"session_id" text NOT NULL,
	"activity_id" text NOT NULL,
	"user_id" text NOT NULL,
	"run_id" text NOT NULL,
	"token_enc" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_version" bigint NOT NULL,
	"fingerprint" text,
	"delivery_timestamp" integer DEFAULT 0 NOT NULL,
	"delivered_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "live_activities_session_id_activity_id_pk" PRIMARY KEY("session_id","activity_id")
);
--> statement-breakpoint
ALTER TABLE "live_activities" ADD CONSTRAINT "live_activities_session_id_mobile_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."mobile_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_activities" ADD CONSTRAINT "live_activities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_activities" ADD CONSTRAINT "live_activities_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "live_activities_token_idx" ON "live_activities" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "live_activities_run_idx" ON "live_activities" USING btree ("session_id","run_id");--> statement-breakpoint
CREATE INDEX "live_activities_due_idx" ON "live_activities" USING btree ("next_attempt_at");