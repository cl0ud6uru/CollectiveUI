CREATE TABLE mcp_app_instances (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  bot_id text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  server_id text NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  tool_name text NOT NULL, definition_hash text NOT NULL, binding text NOT NULL,
  session_version integer NOT NULL, run_id text, payload_enc text NOT NULL,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mcp_app_instance_payload_bound CHECK (octet_length(payload_enc) <= 2000000)
);
--> statement-breakpoint
CREATE INDEX mcp_app_instances_conversation_idx ON mcp_app_instances(conversation_id);
--> statement-breakpoint
CREATE TABLE mcp_app_actions (
  id text PRIMARY KEY, instance_id text NOT NULL REFERENCES mcp_app_instances(id) ON DELETE CASCADE,
  tool_name text NOT NULL, definition_hash text NOT NULL, input jsonb NOT NULL,
  status text NOT NULL, result_enc text, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mcp_app_action_status_check CHECK (status IN ('pending','running','done','denied','error')),
  CONSTRAINT mcp_app_action_input_bound CHECK (octet_length(input::text) <= 65536),
  CONSTRAINT mcp_app_action_result_bound CHECK (result_enc IS NULL OR octet_length(result_enc) <= 2000000)
);
--> statement-breakpoint
CREATE INDEX mcp_app_actions_instance_idx ON mcp_app_actions(instance_id);
