-- evidence_records is append-only (CLAUDE.md rule 2, spec §3).
-- No application path, migration, or job may disable this trigger.
CREATE OR REPLACE FUNCTION evidence_records_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'evidence_records is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER evidence_records_no_update_delete
  BEFORE UPDATE OR DELETE ON evidence_records
  FOR EACH ROW EXECUTE FUNCTION evidence_records_append_only();
--> statement-breakpoint
CREATE TRIGGER evidence_records_no_truncate
  BEFORE TRUNCATE ON evidence_records
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_records_append_only();
