CREATE TABLE "official_plan_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"host_id" text NOT NULL,
	"subject" text NOT NULL,
	"selected" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"scopes" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token_bundle_enc" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"catalog" jsonb NOT NULL,
	"catalog_revision" integer NOT NULL,
	"catalog_expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "official_plan_status_check" CHECK ("official_plan_connections"."status" in ('active','needs_reauth','revoked')),
	CONSTRAINT "official_plan_identity_bound" CHECK (length("official_plan_connections"."client_id") between 1 and 256 and length("official_plan_connections"."host_id") between 1 and 256 and length("official_plan_connections"."subject") between 1 and 256),
	CONSTRAINT "official_plan_revision_check" CHECK ("official_plan_connections"."revision" > 0 and "official_plan_connections"."catalog_revision" = "official_plan_connections"."revision"),
	CONSTRAINT "official_plan_payload_bound" CHECK ("official_plan_connections"."token_bundle_enc" like 'v2.%' and octet_length("official_plan_connections"."token_bundle_enc") <= 50000 and jsonb_typeof("official_plan_connections"."scopes") = 'array' and octet_length("official_plan_connections"."scopes"::text) <= 4096 and jsonb_typeof("official_plan_connections"."catalog") = 'array' and jsonb_array_length("official_plan_connections"."catalog") <= 100 and octet_length("official_plan_connections"."catalog"::text) <= 24000)
);
--> statement-breakpoint
ALTER TABLE "hermes_team_candidate_contexts" ADD COLUMN "personal_binding_hash" text;--> statement-breakpoint
ALTER TABLE "hermes_team_chats" ADD COLUMN "model_choice" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "official_plan_connections" ADD CONSTRAINT "official_plan_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "official_plan_selected_owner_idx" ON "official_plan_connections" USING btree ("user_id") WHERE "official_plan_connections"."selected";--> statement-breakpoint
ALTER TABLE "hermes_team_candidate_contexts" ADD CONSTRAINT "hermes_team_candidate_personal_binding_check" CHECK ("hermes_team_candidate_contexts"."personal_binding_hash" is null or "hermes_team_candidate_contexts"."personal_binding_hash" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "hermes_team_chats" ADD CONSTRAINT "hermes_team_chat_model_choice_check" CHECK ("hermes_team_chats"."model_choice" in ('default','personal'));
--> statement-breakpoint
CREATE FUNCTION official_plan_connection_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.user_id,NEW.client_id,NEW.host_id,NEW.subject,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.client_id,OLD.host_id,OLD.subject,OLD.created_at) THEN
    RAISE EXCEPTION 'Official account identity is immutable';
  END IF;
  IF ROW(NEW.token_bundle_enc,NEW.scopes,NEW.expires_at,NEW.catalog,NEW.catalog_expires_at,NEW.verified_at,NEW.revision,NEW.catalog_revision) IS DISTINCT FROM ROW(OLD.token_bundle_enc,OLD.scopes,OLD.expires_at,OLD.catalog,OLD.catalog_expires_at,OLD.verified_at,OLD.revision,OLD.catalog_revision) AND (NEW.revision <> OLD.revision + 1 OR NEW.catalog_revision <> NEW.revision) THEN
    RAISE EXCEPTION 'Official account proof changes require a new credential/catalog revision';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER official_plan_connection_identity_immutable BEFORE UPDATE ON official_plan_connections FOR EACH ROW EXECUTE FUNCTION official_plan_connection_identity_guard();
--> statement-breakpoint
CREATE FUNCTION hermes_team_personal_context_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.personal_connection_id,NEW.personal_binding_hash) IS DISTINCT FROM ROW(OLD.personal_connection_id,OLD.personal_binding_hash) THEN
    RAISE EXCEPTION 'Native personal account binding is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER hermes_team_personal_context_immutable BEFORE UPDATE ON hermes_team_candidate_contexts FOR EACH ROW EXECUTE FUNCTION hermes_team_personal_context_guard();
