CREATE TABLE "bot_pet_defaults" (
	"bot_id" text PRIMARY KEY NOT NULL,
	"appearance" text NOT NULL,
	"catalog_id" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_pet_default_choice" CHECK (("bot_pet_defaults"."appearance" in ('moss', 'ember', 'off') and "bot_pet_defaults"."catalog_id" is null) or ("bot_pet_defaults"."appearance" = 'catalog' and "bot_pet_defaults"."catalog_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "pet_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"created_by" text,
	"manifest" jsonb NOT NULL,
	"sprite" "bytea" NOT NULL,
	"revision" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pet_catalog_sprite_size" CHECK (octet_length("pet_catalog"."sprite") between 1 and 4194304),
	CONSTRAINT "pet_catalog_status" CHECK ("pet_catalog"."status" in ('draft', 'published', 'unpublished'))
);
--> statement-breakpoint
ALTER TABLE "bot_pets" ADD COLUMN "mode" text DEFAULT 'follow' NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_pets" ADD COLUMN "catalog_id" text;--> statement-breakpoint
ALTER TABLE "bot_pet_defaults" ADD CONSTRAINT "bot_pet_defaults_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_pet_defaults" ADD CONSTRAINT "bot_pet_defaults_catalog_id_pet_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."pet_catalog"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_pet_defaults" ADD CONSTRAINT "bot_pet_defaults_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pet_catalog" ADD CONSTRAINT "pet_catalog_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_pets" ADD CONSTRAINT "bot_pets_catalog_id_pet_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."pet_catalog"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_pets" ADD CONSTRAINT "bot_pets_mode" CHECK ("bot_pets"."mode" in ('follow', 'personal', 'off'));--> statement-breakpoint
ALTER TABLE "bot_pets" ADD CONSTRAINT "bot_pets_choice" CHECK (("bot_pets"."appearance" in ('moss', 'ember', 'custom') and "bot_pets"."catalog_id" is null) or ("bot_pets"."appearance" = 'catalog' and "bot_pets"."catalog_id" is not null));
--> statement-breakpoint
-- Legacy reads never inserted rows: absence was the default-off view and now follows defaults.
-- Every stored row came from an explicit preference/import mutation. Preserve opt-outs and imports.
-- No artwork is published or copied by this migration.
UPDATE "bot_pets" SET "mode" = CASE WHEN "enabled" THEN 'personal' ELSE 'off' END;
