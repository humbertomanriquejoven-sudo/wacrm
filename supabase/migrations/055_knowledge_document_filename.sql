-- 055: record the original uploaded filename on knowledge base documents.
--
-- Until now only `title` was stored, defaulting to the filename minus its
-- extension. That makes "Catalogo.xlsx" and "Catalogo.docx" indistinguishable
-- in the UI, and gives the agent no way to cite the source file it answered
-- from. `filename` is nullable and additive: rows created before this
-- migration simply keep a NULL, and nothing reads it unconditionally.
--
-- `source_type` records which parser produced the text, so a document whose
-- extraction was weak (e.g. an image that OCR could not read) can be
-- identified and re-uploaded rather than silently trusted.

ALTER TABLE ai_knowledge_documents
  ADD COLUMN IF NOT EXISTS filename text,
  ADD COLUMN IF NOT EXISTS source_type text;

-- Backfill the filename from the title for pre-existing rows so the UI has
-- something sensible to show instead of a blank column.
UPDATE ai_knowledge_documents
SET filename = title
WHERE filename IS NULL;