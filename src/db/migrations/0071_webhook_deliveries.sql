ALTER TABLE routine_runs ADD COLUMN webhook_delivery_id text;
--> statement-breakpoint
ALTER TABLE routine_runs ADD COLUMN webhook_payload_hash text;
--> statement-breakpoint
CREATE UNIQUE INDEX routine_runs_webhook_delivery_idx ON routine_runs(routine_id, webhook_delivery_id) WHERE webhook_delivery_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE routine_runs ADD CONSTRAINT routine_runs_webhook_delivery_check CHECK (
  (webhook_delivery_id IS NULL AND webhook_payload_hash IS NULL) OR
  (trigger = 'webhook' AND webhook_delivery_id IS NOT NULL AND webhook_payload_hash IS NOT NULL
   AND webhook_delivery_id ~ '^[A-Za-z0-9_-]{16,100}$' AND webhook_payload_hash ~ '^[a-f0-9]{64}$')
);
