ALTER TABLE loop_runs
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

UPDATE memories
SET expires_at = updated_at + interval '2 days'
WHERE scope_type = 'session'
  AND expires_at IS NULL;

UPDATE loop_runs
SET expires_at = updated_at + interval '2 days'
WHERE expires_at IS NULL;
