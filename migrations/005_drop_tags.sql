DROP INDEX IF EXISTS memories_tags_idx;

CREATE OR REPLACE FUNCTION memories_search_document_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_document :=
    setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A')
    || setweight(to_tsvector('simple', coalesce(NEW.content, '')), 'B');
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS memories_search_document_trigger ON memories;
CREATE TRIGGER memories_search_document_trigger
  BEFORE INSERT OR UPDATE OF title, content ON memories
  FOR EACH ROW
  EXECUTE FUNCTION memories_search_document_update();

ALTER TABLE memories DROP COLUMN IF EXISTS tags;

-- Rebuild search documents without tag tokens.
UPDATE memories
SET title = title;
