CREATE TABLE "official_plan_transfers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_version" integer NOT NULL,
	"transport_id" text NOT NULL,
	"host_id" text NOT NULL,
	"client_id" text NOT NULL,
	"subject" text NOT NULL,
	"workspace_id" text,
	"expected_connection_id" text,
	"expected_revision" integer,
	"refresh_hash" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "official_plan_transfer_state_check" CHECK ("official_plan_transfers"."state" in ('pending','importing','complete','cancelled','needs_attention')),
	CONSTRAINT "official_plan_transfer_identity_check" CHECK ("official_plan_transfers"."session_version" >= 0 and length("official_plan_transfers"."transport_id") between 1 and 256 and length("official_plan_transfers"."host_id") between 1 and 256 and length("official_plan_transfers"."client_id") between 1 and 256 and length("official_plan_transfers"."subject") between 1 and 256 and ("official_plan_transfers"."workspace_id" is null or length("official_plan_transfers"."workspace_id") between 1 and 256) and (("official_plan_transfers"."expected_connection_id" is null) = ("official_plan_transfers"."expected_revision" is null)) and ("official_plan_transfers"."expected_revision" is null or "official_plan_transfers"."expected_revision" > 0)),
	CONSTRAINT "official_plan_transfer_receipt_check" CHECK (("official_plan_transfers"."refresh_hash" is null or "official_plan_transfers"."refresh_hash" ~ '^[a-f0-9]{64}$') and "official_plan_transfers"."expires_at" > "official_plan_transfers"."created_at" and "official_plan_transfers"."expires_at" <= "official_plan_transfers"."created_at" + interval '10 minutes')
);
--> statement-breakpoint
ALTER TABLE "official_plan_connections" ADD COLUMN "provenance" jsonb;--> statement-breakpoint
ALTER TABLE "official_plan_transfers" ADD CONSTRAINT "official_plan_transfers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "official_plan_transfer_open_owner_idx" ON "official_plan_transfers" USING btree ("user_id") WHERE "official_plan_transfers"."state" in ('pending','importing');--> statement-breakpoint
CREATE UNIQUE INDEX "official_plan_transfer_refresh_owner_idx" ON "official_plan_transfers" USING btree ("refresh_hash");
--> statement-breakpoint
CREATE FUNCTION official_plan_transfer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NEW.state <> 'pending' OR NEW.refresh_hash IS NOT NULL OR NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND NOT disabled AND session_version = NEW.session_version)
   OR (NEW.expected_connection_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM official_plan_connections WHERE id = NEW.expected_connection_id AND user_id = NEW.user_id AND revision = NEW.expected_revision AND selected)) THEN
   RAISE EXCEPTION 'Official transfer requires its current owner selection';
  END IF;
 ELSE
  IF ROW(NEW.id,NEW.user_id,NEW.session_version,NEW.transport_id,NEW.host_id,NEW.client_id,NEW.subject,NEW.workspace_id,NEW.expected_connection_id,NEW.expected_revision,NEW.expires_at,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.session_version,OLD.transport_id,OLD.host_id,OLD.client_id,OLD.subject,OLD.workspace_id,OLD.expected_connection_id,OLD.expected_revision,OLD.expires_at,OLD.created_at) THEN
   RAISE EXCEPTION 'Official transfer authority is immutable';
  END IF;
  IF NEW.refresh_hash IS DISTINCT FROM OLD.refresh_hash AND (OLD.refresh_hash IS NOT NULL OR OLD.state <> 'importing') THEN
   RAISE EXCEPTION 'Official transfer custody is immutable';
  END IF;
  IF NEW.state <> OLD.state AND NOT ((OLD.state = 'pending' AND NEW.state IN ('importing','cancelled')) OR (OLD.state = 'importing' AND NEW.state IN ('complete','needs_attention','cancelled')) OR (OLD.state = 'needs_attention' AND NEW.state = 'cancelled')) THEN
   RAISE EXCEPTION 'Official transfer cannot be replayed';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER official_plan_transfer_authority BEFORE INSERT OR UPDATE ON official_plan_transfers FOR EACH ROW EXECUTE FUNCTION official_plan_transfer_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION official_plan_connection_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.user_id,NEW.client_id,NEW.host_id,NEW.subject,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.client_id,OLD.host_id,OLD.subject,OLD.created_at) THEN
  RAISE EXCEPTION 'Official account identity is immutable';
 END IF;
 IF ROW(NEW.token_bundle_enc,NEW.scopes,NEW.expires_at,NEW.catalog,NEW.catalog_expires_at,NEW.verified_at,NEW.revision,NEW.catalog_revision,NEW.provenance)
  IS DISTINCT FROM ROW(OLD.token_bundle_enc,OLD.scopes,OLD.expires_at,OLD.catalog,OLD.catalog_expires_at,OLD.verified_at,OLD.revision,OLD.catalog_revision,OLD.provenance)
  AND (NEW.revision <> OLD.revision + 1 OR NEW.catalog_revision <> NEW.revision) THEN
  RAISE EXCEPTION 'Official account proof changes require a new credential/catalog revision';
 END IF;
 RETURN NEW;
END;
$$;
