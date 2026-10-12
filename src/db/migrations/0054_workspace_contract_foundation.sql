CREATE TABLE "workspace_bot_bindings" (
	"user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_bot_bindings_user_id_bot_id_pk" PRIMARY KEY("user_id","bot_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"template_version_id" text,
	"origin" text NOT NULL,
	"sandbox_ref" text NOT NULL,
	"runtime_profile_key" text NOT NULL,
	"provision_state" text DEFAULT 'missing' NOT NULL,
	"last_used_at" timestamp with time zone,
	"delete_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_instances_ref_check" CHECK ("workspace_instances"."sandbox_ref" ~ '^[a-z0-9]{20}$'),
	CONSTRAINT "workspace_instances_origin_check" CHECK (("workspace_instances"."origin" = 'legacy_personal' and "workspace_instances"."template_version_id" is null) or ("workspace_instances"."origin" = 'template' and "workspace_instances"."template_version_id" is not null)),
	CONSTRAINT "workspace_instances_state_check" CHECK ("workspace_instances"."provision_state" in ('missing', 'provisioning', 'ready', 'unavailable')),
	CONSTRAINT "workspace_instances_profile_check" CHECK ("workspace_instances"."runtime_profile_key" ~ '^[a-z0-9][a-z0-9._-]{0,79}$')
);
--> statement-breakpoint
CREATE TABLE "workspace_template_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"version" integer NOT NULL,
	"recipe" jsonb NOT NULL,
	"recipe_hash" text NOT NULL,
	"published_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_template_versions_positive_check" CHECK ("workspace_template_versions"."version" > 0),
	CONSTRAINT "workspace_template_versions_hash_check" CHECK ("workspace_template_versions"."recipe_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "workspace_template_versions_recipe_check" CHECK (jsonb_typeof("workspace_template_versions"."recipe") = 'object' and "workspace_template_versions"."recipe" @> '{"schemaVersion":1,"networkPolicy":"none"}'::jsonb),
	CONSTRAINT "workspace_template_versions_retirement_check" CHECK ("workspace_template_versions"."retired_at" is null or ("workspace_template_versions"."published_at" is not null and "workspace_template_versions"."retired_at" >= "workspace_template_versions"."published_at"))
);
--> statement-breakpoint
CREATE TABLE "workspace_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_templates_slug_check" CHECK ("workspace_templates"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("workspace_templates"."slug") <= 80)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_instances_owner_id_idx" ON "workspace_instances" USING btree ("owner_user_id","id");
--> statement-breakpoint
ALTER TABLE "workspace_bot_bindings" ADD CONSTRAINT "workspace_bot_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_bot_bindings" ADD CONSTRAINT "workspace_bot_bindings_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_bot_bindings" ADD CONSTRAINT "workspace_bot_bindings_owner_instance_fk" FOREIGN KEY ("user_id","instance_id") REFERENCES "public"."workspace_instances"("owner_user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_instances" ADD CONSTRAINT "workspace_instances_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_instances" ADD CONSTRAINT "workspace_instances_template_version_id_workspace_template_versions_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."workspace_template_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_template_versions" ADD CONSTRAINT "workspace_template_versions_template_id_workspace_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."workspace_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_bot_bindings_instance_idx" ON "workspace_bot_bindings" USING btree ("instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_instances_ref_idx" ON "workspace_instances" USING btree ("sandbox_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_instances_legacy_owner_idx" ON "workspace_instances" USING btree ("owner_user_id") WHERE "workspace_instances"."origin" = 'legacy_personal';--> statement-breakpoint
CREATE INDEX "workspace_instances_retention_idx" ON "workspace_instances" USING btree ("delete_after");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_template_versions_number_idx" ON "workspace_template_versions" USING btree ("template_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_templates_slug_idx" ON "workspace_templates" USING btree ("slug");
--> statement-breakpoint
-- Register existing personal workspaces without touching their refs, volumes, or legacy rows.
INSERT INTO workspace_instances (id, owner_user_id, template_version_id, origin,
  sandbox_ref, runtime_profile_key, provision_state, last_used_at, delete_after, created_at)
SELECT gen_random_uuid()::text, user_id, NULL, 'legacy_personal', ref, 'legacy',
  'missing', last_used_at, delete_after, created_at FROM sandboxes
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION workspace_template_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Published workspace versions cannot be deleted';
    END IF;
    IF ROW(NEW.id, NEW.template_id, NEW.version, NEW.recipe, NEW.recipe_hash, NEW.published_at, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.template_id, OLD.version, OLD.recipe, OLD.recipe_hash, OLD.published_at, OLD.created_at)
       OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at) THEN
      RAISE EXCEPTION 'Published workspace version identity and recipe are immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER workspace_template_version_immutable
BEFORE UPDATE OR DELETE ON workspace_template_versions
FOR EACH ROW EXECUTE FUNCTION workspace_template_version_guard();
--> statement-breakpoint
CREATE FUNCTION workspace_instance_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.owner_user_id, NEW.template_version_id, NEW.origin, NEW.sandbox_ref, NEW.runtime_profile_key)
     IS DISTINCT FROM ROW(OLD.id, OLD.owner_user_id, OLD.template_version_id, OLD.origin, OLD.sandbox_ref, OLD.runtime_profile_key) THEN
    RAISE EXCEPTION 'Workspace instance ownership and pinned identity are immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER workspace_instance_identity_immutable
BEFORE UPDATE ON workspace_instances
FOR EACH ROW EXECUTE FUNCTION workspace_instance_identity_guard();
