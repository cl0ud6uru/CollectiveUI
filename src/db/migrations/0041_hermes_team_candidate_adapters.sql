CREATE TABLE "hermes_team_candidate_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"context_id" text NOT NULL,
	"input_hash" text NOT NULL,
	"attribution" jsonb NOT NULL,
	"input" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"request_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hermes_team_candidate_approval_state_check" CHECK ("hermes_team_candidate_approvals"."state" in ('pending','approved','rejected','consumed')),
	CONSTRAINT "hermes_team_candidate_approval_attribution_bound" CHECK (jsonb_typeof("hermes_team_candidate_approvals"."attribution") = 'object' and octet_length("hermes_team_candidate_approvals"."attribution"::text) <= 8192),
	CONSTRAINT "hermes_team_candidate_approval_input_bound" CHECK (octet_length("hermes_team_candidate_approvals"."input"::text) <= 128000 and "hermes_team_candidate_approvals"."input_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "hermes_team_candidate_contexts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"session_version" integer NOT NULL,
	"definition_version" integer NOT NULL,
	"team_revision" integer,
	"mode" text NOT NULL,
	"model_route" jsonb NOT NULL,
	"personal_connection_id" text,
	"binding_hash" text NOT NULL,
	"model_tokens" jsonb NOT NULL,
	"tool_token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hermes_team_candidate_mode_check" CHECK ("hermes_team_candidate_contexts"."mode" in ('member','admin')),
	CONSTRAINT "hermes_team_candidate_route_bound" CHECK (jsonb_typeof("hermes_team_candidate_contexts"."model_route") = 'object' and octet_length("hermes_team_candidate_contexts"."model_route"::text) <= 8192),
	CONSTRAINT "hermes_team_candidate_context_versions_check" CHECK ("hermes_team_candidate_contexts"."session_version" >= 0 and "hermes_team_candidate_contexts"."definition_version" > 0 and ("hermes_team_candidate_contexts"."team_revision" is null or "hermes_team_candidate_contexts"."team_revision" > 0)),
	CONSTRAINT "hermes_team_candidate_context_hash_check" CHECK ("hermes_team_candidate_contexts"."binding_hash" ~ '^[a-f0-9]{64}$' and "hermes_team_candidate_contexts"."tool_token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "hermes_team_candidate_context_tokens_bound" CHECK (jsonb_typeof("hermes_team_candidate_contexts"."model_tokens") = 'object' and octet_length("hermes_team_candidate_contexts"."model_tokens"::text) <= 512)
);
--> statement-breakpoint
CREATE TABLE "hermes_team_candidate_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"context_id" text NOT NULL,
	"request_id" text NOT NULL,
	"kind" text NOT NULL,
	"purpose" text,
	"input_hash" text NOT NULL,
	"output_reserved" integer DEFAULT 0 NOT NULL,
	"input_reserved_bytes" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hermes_team_candidate_request_kind_check" CHECK ("hermes_team_candidate_requests"."kind" in ('model','tool')),
	CONSTRAINT "hermes_team_candidate_request_state_check" CHECK ("hermes_team_candidate_requests"."state" in ('reserved','running','complete','needs_attention')),
	CONSTRAINT "hermes_team_candidate_request_reserve_check" CHECK ("hermes_team_candidate_requests"."output_reserved" between 0 and 256 and "hermes_team_candidate_requests"."input_reserved_bytes" between 0 and 64000),
	CONSTRAINT "hermes_team_candidate_request_hash_check" CHECK ("hermes_team_candidate_requests"."input_hash" ~ '^[a-f0-9]{64}$' and length("hermes_team_candidate_requests"."request_id") between 1 and 100),
	CONSTRAINT "hermes_team_candidate_request_response_bound" CHECK ("hermes_team_candidate_requests"."response" is null or (jsonb_typeof("hermes_team_candidate_requests"."response") = 'object' and octet_length("hermes_team_candidate_requests"."response"::text) <= 12582912)),
	CONSTRAINT "hermes_team_candidate_request_purpose_check" CHECK ("hermes_team_candidate_requests"."purpose" is null or "hermes_team_candidate_requests"."purpose" in ('reply','learning','utility','subagent'))
);
--> statement-breakpoint
ALTER TABLE "hermes_team_candidate_approvals" ADD CONSTRAINT "hermes_team_candidate_approvals_context_id_hermes_team_candidate_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."hermes_team_candidate_contexts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_candidate_contexts" ADD CONSTRAINT "hermes_team_candidate_contexts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_candidate_contexts" ADD CONSTRAINT "hermes_team_candidate_contexts_bot_id_hermes_team_definitions_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."hermes_team_definitions"("bot_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_candidate_contexts" ADD CONSTRAINT "hermes_team_candidate_contexts_profile_id_hermes_team_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."hermes_team_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_candidate_contexts" ADD CONSTRAINT "hermes_team_candidate_contexts_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_team_candidate_requests" ADD CONSTRAINT "hermes_team_candidate_requests_context_id_hermes_team_candidate_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."hermes_team_candidate_contexts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_team_candidate_approval_request_idx" ON "hermes_team_candidate_approvals" USING btree ("context_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_team_candidate_run_idx" ON "hermes_team_candidate_contexts" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_team_candidate_profile_active_idx" ON "hermes_team_candidate_contexts" USING btree ("profile_id") WHERE "hermes_team_candidate_contexts"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_team_candidate_request_idx" ON "hermes_team_candidate_requests" USING btree ("context_id","kind","request_id");