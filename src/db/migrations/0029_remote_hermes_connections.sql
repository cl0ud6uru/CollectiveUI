CREATE TABLE remote_hermes_connections (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  base_url text NOT NULL,
  auth_mode text NOT NULL CONSTRAINT remote_hermes_auth_mode_check CHECK (auth_mode IN ('password', 'sessionToken')),
  secret_enc text NOT NULL,
  version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX remote_hermes_owner_url_idx ON remote_hermes_connections(user_id, base_url);
