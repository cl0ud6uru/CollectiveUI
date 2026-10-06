ALTER TABLE remote_hermes_sessions ADD COLUMN revision integer NOT NULL DEFAULT 0;
ALTER TABLE remote_hermes_sessions ADD COLUMN admission_request_id text;
ALTER TABLE remote_hermes_sessions ADD COLUMN queue_request_id text;
ALTER TABLE remote_hermes_sessions ADD COLUMN queue_status text;
ALTER TABLE remote_hermes_sessions ADD CONSTRAINT remote_hermes_queue_check
  CHECK ((queue_request_id IS NULL) = (queue_status IS NULL)
    AND (queue_status IS NULL OR queue_status IN ('admitting', 'queued', 'uncertain')));
