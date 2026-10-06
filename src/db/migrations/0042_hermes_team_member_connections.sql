CREATE TABLE "mcp_member_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"server_id" text NOT NULL,
	"target_hash" text NOT NULL,
	"headers_enc" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_member_connections_status_check" CHECK ("mcp_member_connections"."status" in ('active', 'revoked')),
	CONSTRAINT "mcp_member_connections_revision_check" CHECK ("mcp_member_connections"."revision" > 0),
	CONSTRAINT "mcp_member_connections_target_check" CHECK ("mcp_member_connections"."target_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "mcp_member_connections" ADD CONSTRAINT "mcp_member_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_member_connections" ADD CONSTRAINT "mcp_member_connections_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_member_connections_owner_server_idx" ON "mcp_member_connections" USING btree ("user_id","server_id");
--> statement-breakpoint
-- A saved account cannot be reassigned; every mutation invalidates old approval bindings.
CREATE FUNCTION collective_mcp_member_connection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.server_id IS DISTINCT FROM OLD.server_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.revision <> OLD.revision + 1
    OR (NEW.target_hash IS DISTINCT FROM OLD.target_hash AND NEW.headers_enc IS NOT DISTINCT FROM OLD.headers_enc) THEN
    RAISE EXCEPTION 'Member MCP connection identity is immutable and revision must advance once';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mcp_member_connection_guard BEFORE UPDATE ON mcp_member_connections
FOR EACH ROW EXECUTE FUNCTION collective_mcp_member_connection_guard();
