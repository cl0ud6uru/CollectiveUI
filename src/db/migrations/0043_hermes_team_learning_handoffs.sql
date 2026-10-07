CREATE TABLE "hermes_team_learning_handoffs" (
	"id" text PRIMARY KEY NOT NULL,
	"source_context_id" text NOT NULL,
	"review_id" text NOT NULL,
	"child_run_id" text,
	"actor_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"session_version" integer NOT NULL,
	"definition_version" integer NOT NULL,
	"team_revision" integer,
	"mode" text NOT NULL,
	"binding_hash" text NOT NULL,
	"route_hash" text NOT NULL,
	"snapshot_hash" text NOT NULL,
	"snapshot_bytes" integer NOT NULL,
	"payload_enc" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hermes_team_learning_state_check" CHECK ("hermes_team_learning_handoffs"."state" in ('pending','queued','running','complete','cancelled','needs_attention')),
	CONSTRAINT "hermes_team_learning_identity_check" CHECK ("hermes_team_learning_handoffs"."mode" in ('member','admin') and "hermes_team_learning_handoffs"."session_version" >= 0 and "hermes_team_learning_handoffs"."definition_version" > 0 and ("hermes_team_learning_handoffs"."team_revision" is null or "hermes_team_learning_handoffs"."team_revision" > 0)),
	CONSTRAINT "hermes_team_learning_hash_check" CHECK ("hermes_team_learning_handoffs"."binding_hash" ~ '^[a-f0-9]{64}$' and "hermes_team_learning_handoffs"."route_hash" ~ '^[a-f0-9]{64}$' and "hermes_team_learning_handoffs"."snapshot_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "hermes_team_learning_snapshot_check" CHECK ("hermes_team_learning_handoffs"."snapshot_bytes" between 1 and 64000 and octet_length("hermes_team_learning_handoffs"."payload_enc") <= 100000 and length("hermes_team_learning_handoffs"."review_id") = 36)
);
--> statement-breakpoint
ALTER TABLE "hermes_team_candidate_contexts" ADD COLUMN "learning_token_hash" text;--> statement-breakpoint
ALTER TABLE "hermes_team_candidate_contexts" ADD COLUMN "worker_holder" text;--> statement-breakpoint
ALTER TABLE "hermes_team_candidate_contexts" ADD COLUMN "worker_segment" integer;--> statement-breakpoint
ALTER TABLE "hermes_team_candidate_contexts" ADD COLUMN "retirement_state" text;--> statement-breakpoint
ALTER TABLE "hermes_team_candidate_contexts" ADD COLUMN "native_stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hermes_team_learning_handoffs" ADD CONSTRAINT "hermes_team_learning_handoffs_source_context_id_hermes_team_candidate_contexts_id_fk" FOREIGN KEY ("source_context_id") REFERENCES "public"."hermes_team_candidate_contexts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_learning_handoffs" ADD CONSTRAINT "hermes_team_learning_handoffs_child_run_id_agent_runs_id_fk" FOREIGN KEY ("child_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_learning_handoffs" ADD CONSTRAINT "hermes_team_learning_handoffs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_learning_handoffs" ADD CONSTRAINT "hermes_team_learning_handoffs_bot_id_hermes_team_definitions_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."hermes_team_definitions"("bot_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_learning_handoffs" ADD CONSTRAINT "hermes_team_learning_handoffs_profile_id_hermes_team_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."hermes_team_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_team_learning_source_idx" ON "hermes_team_learning_handoffs" USING btree ("source_context_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_team_learning_review_idx" ON "hermes_team_learning_handoffs" USING btree ("source_context_id","review_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_team_learning_child_idx" ON "hermes_team_learning_handoffs" USING btree ("child_run_id");--> statement-breakpoint
ALTER TABLE "hermes_team_candidate_contexts" ADD CONSTRAINT "hermes_team_candidate_learning_hash_check" CHECK ("hermes_team_candidate_contexts"."learning_token_hash" is null or "hermes_team_candidate_contexts"."learning_token_hash" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "hermes_team_candidate_contexts" ADD CONSTRAINT "hermes_team_candidate_retirement_check" CHECK (("hermes_team_candidate_contexts"."retirement_state" is null or "hermes_team_candidate_contexts"."retirement_state" in ('pending','confirmed','needs_attention')) and ("hermes_team_candidate_contexts"."native_stopped_at" is null or "hermes_team_candidate_contexts"."retirement_state" = 'confirmed') and ("hermes_team_candidate_contexts"."worker_segment" is null or "hermes_team_candidate_contexts"."worker_segment" >= 0));--> statement-breakpoint
CREATE FUNCTION hermes_team_learning_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.id,NEW.source_context_id,NEW.review_id,NEW.actor_id,NEW.bot_id,NEW.profile_id,NEW.session_version,NEW.definition_version,NEW.team_revision,NEW.mode,NEW.binding_hash,NEW.route_hash,NEW.snapshot_hash,NEW.snapshot_bytes,NEW.payload_enc,NEW.expires_at,NEW.created_at)
 IS DISTINCT FROM (OLD.id,OLD.source_context_id,OLD.review_id,OLD.actor_id,OLD.bot_id,OLD.profile_id,OLD.session_version,OLD.definition_version,OLD.team_revision,OLD.mode,OLD.binding_hash,OLD.route_hash,OLD.snapshot_hash,OLD.snapshot_bytes,OLD.payload_enc,OLD.expires_at,OLD.created_at)
 OR (OLD.child_run_id IS NOT NULL AND NEW.child_run_id IS DISTINCT FROM OLD.child_run_id) THEN
  RAISE EXCEPTION 'native learning handoff identity is immutable';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER hermes_team_learning_identity_guard BEFORE UPDATE ON hermes_team_learning_handoffs FOR EACH ROW EXECUTE FUNCTION hermes_team_learning_identity_immutable();
