DO $$
BEGIN
  CREATE TYPE memory_usage_metric AS ENUM (
    'store_succeeded',
    'store_failed',
    'update_succeeded',
    'update_failed',
    'archive_succeeded',
    'archive_failed',
    'forget_succeeded',
    'forget_failed',
    'search_succeeded',
    'search_failed',
    'search_missed',
    'list_succeeded',
    'list_failed',
    'accessed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS memory_usage_counters (
  owner_id text NOT NULL,
  metric memory_usage_metric NOT NULL,
  count bigint NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, metric)
);
