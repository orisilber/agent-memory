CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

DO $$
BEGIN
  CREATE TYPE memory_scope AS ENUM ('global', 'repo', 'session');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE memory_kind AS ENUM ('preference', 'procedure', 'decision', 'fact');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE loop_status AS ENUM ('running', 'paused', 'completed', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS memories (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  scope_type memory_scope NOT NULL,
  scope_id text NOT NULL,
  kind memory_kind NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}',
  provenance jsonb NOT NULL DEFAULT '{}',
  confidence real,
  importance real NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  content_hash text NOT NULL,
  embedding_model text,
  embedding vector,
  search_document tsvector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_accessed_at timestamptz,
  expires_at timestamptz,
  archived_at timestamptz,
  UNIQUE (owner_id, scope_type, scope_id, kind, content_hash)
);

CREATE OR REPLACE FUNCTION memories_search_document_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_document :=
    setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A')
    || setweight(to_tsvector('simple', coalesce(NEW.content, '')), 'B')
    || setweight(
      to_tsvector('simple', coalesce(array_to_string(NEW.tags, ' '), '')),
      'C'
    );
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS memories_search_document_trigger ON memories;
CREATE TRIGGER memories_search_document_trigger
  BEFORE INSERT OR UPDATE OF title, content, tags ON memories
  FOR EACH ROW
  EXECUTE FUNCTION memories_search_document_update();

CREATE INDEX IF NOT EXISTS memories_scope_idx
  ON memories (owner_id, scope_type, scope_id, archived_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS memories_search_idx
  ON memories USING gin (search_document);
CREATE INDEX IF NOT EXISTS memories_content_trgm_idx
  ON memories USING gin (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS memories_title_trgm_idx
  ON memories USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS memories_tags_idx
  ON memories USING gin (tags);

CREATE TABLE IF NOT EXISTS loop_runs (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  session_id text NOT NULL,
  repo_id text,
  task text NOT NULL,
  status loop_status NOT NULL DEFAULT 'running',
  current_step integer NOT NULL DEFAULT 0 CHECK (current_step >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS loop_runs_lookup_idx
  ON loop_runs (owner_id, session_id, repo_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS loop_checkpoints (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES loop_runs(id) ON DELETE CASCADE,
  step integer NOT NULL CHECK (step >= 0),
  completed_summary text NOT NULL,
  artifacts jsonb NOT NULL DEFAULT '[]',
  errors jsonb NOT NULL DEFAULT '[]',
  state jsonb NOT NULL DEFAULT '{}',
  next_action text,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS loop_checkpoints_latest_idx
  ON loop_checkpoints (run_id, step DESC, created_at DESC);
