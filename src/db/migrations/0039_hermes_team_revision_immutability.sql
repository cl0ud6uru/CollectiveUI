CREATE FUNCTION "hermes_team_revision_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Published Hermes Team Bot revisions are immutable' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "hermes_team_revision_immutable_trigger"
BEFORE UPDATE OR DELETE ON "hermes_team_revisions"
FOR EACH ROW EXECUTE FUNCTION "hermes_team_revision_immutable"();
