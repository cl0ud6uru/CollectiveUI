CREATE TABLE "bot_mcp_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"bot_revision" integer NOT NULL,
	"server_id" text NOT NULL,
	"server_revision" integer NOT NULL,
	"tool_name" text NOT NULL,
	"tool_hash" text NOT NULL,
	"effect" text DEFAULT 'write' NOT NULL,
	"require_approval" boolean DEFAULT true NOT NULL,
	"constraints" jsonb NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "bot_mcp_grants_effect_check" CHECK ("bot_mcp_grants"."effect" in ('read', 'write')),
	CONSTRAINT "bot_mcp_grants_write_approval_check" CHECK ("bot_mcp_grants"."effect" <> 'write' or "bot_mcp_grants"."require_approval")
);
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "execution_mode" text DEFAULT 'caller' NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "published_revision" integer;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "published_config_hash" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "policy_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_mcp_grants" ADD CONSTRAINT "bot_mcp_grants_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_mcp_grants" ADD CONSTRAINT "bot_mcp_grants_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_mcp_grants" ADD CONSTRAINT "bot_mcp_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_mcp_grants_bot_idx" ON "bot_mcp_grants" USING btree ("bot_id","bot_revision");--> statement-breakpoint
CREATE INDEX "bot_mcp_grants_server_idx" ON "bot_mcp_grants" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_mcp_grants_active_idx" ON "bot_mcp_grants" USING btree ("bot_id","server_id","tool_name") WHERE "bot_mcp_grants"."revoked_at" is null;