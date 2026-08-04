CREATE INDEX IF NOT EXISTS loop_runs_expiry_idx
  ON loop_runs (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS memories_expiry_idx
  ON memories (expires_at)
  WHERE expires_at IS NOT NULL;
