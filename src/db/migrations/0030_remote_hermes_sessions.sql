CREATE TABLE remote_hermes_sessions (
  id text PRIMARY KEY,
  connection_id text NOT NULL REFERENCES remote_hermes_connections(id) ON DELETE CASCADE,
  profile text NOT NULL,
  stored_id text NOT NULL,
  runtime_id text,
  title text NOT NULL DEFAULT 'New Hermes chat',
  status text NOT NULL DEFAULT 'idle' CONSTRAINT remote_hermes_session_status_check CHECK (status IN ('idle','admitting','running','waiting','uncertain')),
  admission_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX remote_hermes_session_native_idx ON remote_hermes_sessions(connection_id, profile, stored_id);
CREATE TABLE remote_hermes_turns (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES remote_hermes_sessions(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX remote_hermes_turn_receipt_idx ON remote_hermes_turns(session_id, request_id);
