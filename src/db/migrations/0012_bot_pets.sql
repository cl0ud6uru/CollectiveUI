CREATE TABLE "bot_pets" (
	"user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"appearance" text DEFAULT 'moss' NOT NULL,
	"motion" text DEFAULT 'auto' NOT NULL,
	"custom" jsonb,
	"sprite" "bytea",
	"revision" text,
	CONSTRAINT "bot_pets_user_id_bot_id_pk" PRIMARY KEY("user_id","bot_id"),
	CONSTRAINT "bot_pets_sprite_size" CHECK ("bot_pets"."sprite" is null or octet_length("bot_pets"."sprite") <= 4194304)
);
--> statement-breakpoint
ALTER TABLE "bot_pets" ADD CONSTRAINT "bot_pets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_pets" ADD CONSTRAINT "bot_pets_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;