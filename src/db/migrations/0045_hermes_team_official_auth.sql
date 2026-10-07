CREATE TABLE "official_plan_auth_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_version" integer NOT NULL,
	"transport_id" text NOT NULL,
	"host_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"state_hash" text NOT NULL,
	"return_token_hash" text NOT NULL,
	"secret_enc" text NOT NULL,
	"expected_connection_id" text,
	"expected_revision" integer,
	"callback_hash" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "official_plan_auth_state_check" CHECK ("official_plan_auth_attempts"."state" in ('pending','exchanging','complete','cancelled','needs_attention','expired')),
	CONSTRAINT "official_plan_auth_identity_check" CHECK ("official_plan_auth_attempts"."session_version" >= 0 and length("official_plan_auth_attempts"."transport_id") between 1 and 128 and length("official_plan_auth_attempts"."host_id") between 1 and 256 and length("official_plan_auth_attempts"."redirect_uri") <= 256 and ("official_plan_auth_attempts"."expected_revision" is null or "official_plan_auth_attempts"."expected_revision" > 0) and (("official_plan_auth_attempts"."expected_connection_id" is null) = ("official_plan_auth_attempts"."expected_revision" is null))),
	CONSTRAINT "official_plan_auth_secret_check" CHECK ("official_plan_auth_attempts"."state_hash" ~ '^[a-f0-9]{64}$' and "official_plan_auth_attempts"."return_token_hash" ~ '^[a-f0-9]{64}$' and ("official_plan_auth_attempts"."callback_hash" is null or "official_plan_auth_attempts"."callback_hash" ~ '^[a-f0-9]{64}$') and "official_plan_auth_attempts"."secret_enc" like 'v2.%' and octet_length("official_plan_auth_attempts"."secret_enc") <= 64000 and "official_plan_auth_attempts"."expires_at" > "official_plan_auth_attempts"."created_at" and "official_plan_auth_attempts"."expires_at" <= "official_plan_auth_attempts"."created_at" + interval '10 minutes')
);
--> statement-breakpoint
CREATE TABLE "official_plan_auth_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"session_version" integer NOT NULL,
	"credential_revision" integer NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "official_plan_auth_operation_state_check" CHECK ("official_plan_auth_operations"."kind" in ('refresh','revoke') and "official_plan_auth_operations"."state" in ('running','complete','cancelled','needs_attention') and "official_plan_auth_operations"."session_version" >= 0 and "official_plan_auth_operations"."credential_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "official_plan_auth_attempts" ADD CONSTRAINT "official_plan_auth_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "official_plan_auth_operations" ADD CONSTRAINT "official_plan_auth_operations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "official_plan_auth_operations" ADD CONSTRAINT "official_plan_auth_operations_connection_id_official_plan_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."official_plan_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "official_plan_auth_state_idx" ON "official_plan_auth_attempts" USING btree ("state_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "official_plan_auth_open_owner_idx" ON "official_plan_auth_attempts" USING btree ("user_id") WHERE "official_plan_auth_attempts"."state" in ('pending','exchanging');--> statement-breakpoint
CREATE UNIQUE INDEX "official_plan_auth_operation_revision_idx" ON "official_plan_auth_operations" USING btree ("connection_id","kind","credential_revision");--> statement-breakpoint
CREATE FUNCTION official_plan_auth_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.user_id,NEW.session_version,NEW.transport_id,NEW.host_id,NEW.redirect_uri,NEW.state_hash,NEW.return_token_hash,NEW.secret_enc,NEW.expected_connection_id,NEW.expected_revision,NEW.expires_at,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.session_version,OLD.transport_id,OLD.host_id,OLD.redirect_uri,OLD.state_hash,OLD.return_token_hash,OLD.secret_enc,OLD.expected_connection_id,OLD.expected_revision,OLD.expires_at,OLD.created_at) THEN
  RAISE EXCEPTION 'Official authorization authority is immutable';
 END IF;
 IF NEW.callback_hash IS DISTINCT FROM OLD.callback_hash AND (OLD.callback_hash IS NOT NULL OR OLD.state <> 'pending') THEN
  RAISE EXCEPTION 'Official callback binding is immutable';
 END IF;
 IF NEW.state <> OLD.state AND NOT ((OLD.state = 'pending' AND NEW.state IN ('exchanging','cancelled','expired')) OR (OLD.state = 'exchanging' AND NEW.state IN ('complete','needs_attention','cancelled')) OR (OLD.state = 'needs_attention' AND NEW.state = 'cancelled')) THEN
  RAISE EXCEPTION 'Official authorization cannot be replayed';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER official_plan_auth_attempt_immutable BEFORE UPDATE ON official_plan_auth_attempts FOR EACH ROW EXECUTE FUNCTION official_plan_auth_attempt_guard();
--> statement-breakpoint
CREATE FUNCTION official_plan_auth_operation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.user_id,NEW.connection_id,NEW.session_version,NEW.credential_revision,NEW.kind,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.connection_id,OLD.session_version,OLD.credential_revision,OLD.kind,OLD.created_at) THEN
  RAISE EXCEPTION 'Official token operation authority is immutable';
 END IF;
 IF NEW.state <> OLD.state AND NOT ((OLD.state = 'running' AND NEW.state IN ('complete','needs_attention','cancelled')) OR (OLD.state = 'needs_attention' AND NEW.state = 'cancelled')) THEN
  RAISE EXCEPTION 'Official token operation cannot be replayed';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER official_plan_auth_operation_immutable BEFORE UPDATE ON official_plan_auth_operations FOR EACH ROW EXECUTE FUNCTION official_plan_auth_operation_guard();
--> statement-breakpoint
CREATE FUNCTION official_plan_auth_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND NOT disabled AND session_version = NEW.session_version) THEN
  RAISE EXCEPTION 'Official auth receipt requires its current owner session';
 END IF;
 IF TG_TABLE_NAME = 'official_plan_auth_attempts' THEN
  IF NEW.state <> 'pending' OR NEW.callback_hash IS NOT NULL OR (NEW.expected_connection_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM official_plan_connections WHERE id = NEW.expected_connection_id AND user_id = NEW.user_id AND revision = NEW.expected_revision AND selected)) THEN
   RAISE EXCEPTION 'Official attempt requires its current owner registration';
  END IF;
 ELSE
  IF NEW.state <> 'running' OR NOT EXISTS (SELECT 1 FROM official_plan_connections WHERE id = NEW.connection_id AND user_id = NEW.user_id AND revision = NEW.credential_revision) THEN
   RAISE EXCEPTION 'Official token operation requires its current owner registration';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER official_plan_auth_attempt_insert BEFORE INSERT ON official_plan_auth_attempts FOR EACH ROW EXECUTE FUNCTION official_plan_auth_insert_guard();
--> statement-breakpoint
CREATE TRIGGER official_plan_auth_operation_insert BEFORE INSERT ON official_plan_auth_operations FOR EACH ROW EXECUTE FUNCTION official_plan_auth_insert_guard();
