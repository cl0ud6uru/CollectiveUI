CREATE TABLE "remote_hermes_hub_owners" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"owner_instance_id" text NOT NULL,
	"generation" bigint DEFAULT 1 NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"socket_epoch" bigint DEFAULT 0 NOT NULL,
	"native_protocol" text,
	"native_generation" bigint,
	"native_socket_epoch" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remote_hermes_hub_owner_generation_check" CHECK ("remote_hermes_hub_owners"."generation" > 0),
	CONSTRAINT "remote_hermes_hub_owner_socket_epoch_check" CHECK ("remote_hermes_hub_owners"."socket_epoch" >= 0),
	CONSTRAINT "remote_hermes_hub_native_fence_check" CHECK ((("remote_hermes_hub_owners"."native_protocol" is null and "remote_hermes_hub_owners"."native_generation" is null and "remote_hermes_hub_owners"."native_socket_epoch" is null) or ("remote_hermes_hub_owners"."native_protocol" = 'collective.native-hub-owner.v1' and "remote_hermes_hub_owners"."native_generation" > 0 and "remote_hermes_hub_owners"."native_socket_epoch" = "remote_hermes_hub_owners"."socket_epoch")) is true)
);
--> statement-breakpoint
ALTER TABLE "remote_hermes_sessions" ADD COLUMN "ownership_generation" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "remote_hermes_hub_owners" ADD CONSTRAINT "remote_hermes_hub_owners_connection_id_remote_hermes_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."remote_hermes_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_hermes_sessions" ADD CONSTRAINT "remote_hermes_session_ownership_generation_check" CHECK ("remote_hermes_sessions"."ownership_generation" >= 0);
