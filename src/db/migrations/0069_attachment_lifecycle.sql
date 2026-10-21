ALTER TABLE "attachments" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "upload_complete" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "attachments_cleanup_idx" ON "attachments" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "knowledge_attachment_idx" ON "knowledge_chunks" USING btree ("attachment_id");--> statement-breakpoint
CREATE INDEX "messages_attachment_parts_idx" ON "messages" USING gin ("parts");
--> statement-breakpoint
-- Writers and the sweeper serialize on individual attachment rows. No live file may acquire a new reference
-- after the retirement tombstone commits. Missing legacy IDs remain unavailable instead of blocking replay.
CREATE FUNCTION guard_message_attachment_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE attachment record;
BEGIN
  FOR attachment IN
    SELECT a.id, a.deleted_at, a.upload_complete FROM attachments a
    WHERE a.id IN (
      SELECT substring(part->>'url' from '^/api/files/([A-Za-z0-9]+)$')
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.parts) = 'array' THEN NEW.parts ELSE '[]'::jsonb END) part
      WHERE part->>'type' = 'file'
    )
    ORDER BY a.id FOR SHARE OF a
  LOOP
    IF attachment.deleted_at IS NOT NULL OR NOT attachment.upload_complete THEN
      RAISE EXCEPTION 'Attachment is unavailable; upload it again' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER messages_attachment_lifecycle BEFORE INSERT OR UPDATE OF parts ON messages
FOR EACH ROW EXECUTE FUNCTION guard_message_attachment_lifecycle();
--> statement-breakpoint
CREATE FUNCTION guard_knowledge_attachment_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE attachment record;
BEGIN
  SELECT a.deleted_at, a.upload_complete INTO attachment FROM attachments a
  WHERE a.id = NEW.attachment_id FOR SHARE OF a;
  IF FOUND AND (attachment.deleted_at IS NOT NULL OR NOT attachment.upload_complete) THEN
    RAISE EXCEPTION 'Attachment is unavailable; upload it again' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER knowledge_attachment_lifecycle BEFORE INSERT OR UPDATE OF attachment_id ON knowledge_chunks
FOR EACH ROW EXECUTE FUNCTION guard_knowledge_attachment_lifecycle();
