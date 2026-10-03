ALTER TABLE "bot_tools" ADD COLUMN "config" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "trust" text DEFAULT 'untrusted' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "identity_header" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "identity_secret_enc" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "tools_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "tools_hash" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "tools_drift" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "server_info" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "tool_policy" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "result_budget_kb" integer DEFAULT 64 NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "timeout_ms" integer DEFAULT 60000 NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "last_tested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "last_error" text;--> statement-breakpoint
-- Servers added before P4 keep working: enabled ones stay enabled (their tool list is captured by the next
-- refresh), disabled ones stay disabled. New servers start as drafts.
UPDATE "mcp_servers" SET "status" = CASE WHEN "enabled" THEN 'enabled' ELSE 'disabled' END;--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "enabled";--> statement-breakpoint
ALTER TABLE "bot_tools" ADD CONSTRAINT "bot_tools_approval_check" CHECK ("bot_tools"."approval" in ('auto', 'ask', 'smart'));--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_status_check" CHECK ("mcp_servers"."status" in ('draft', 'enabled', 'disabled', 'needs_review'));--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_trust_check" CHECK ("mcp_servers"."trust" in ('untrusted', 'trusted'));--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_budget_check" CHECK ("mcp_servers"."result_budget_kb" between 1 and 1024);--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_timeout_check" CHECK ("mcp_servers"."timeout_ms" between 1000 and 600000);