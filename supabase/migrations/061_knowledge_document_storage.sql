-- ============================================================
-- 061_knowledge_document_storage.sql — store the ORIGINAL uploaded
--                                    file + document lifecycle status
--
-- Until now the knowledge base persisted only the text extracted from
-- an upload (`ai_knowledge_documents.content`, migration 030). That is
-- enough to search, but it loses the original artifact: there is no way
-- to re-download "Catalogo.xlsx", to re-parse it with a better parser
-- later, or to prove what exactly was uploaded. And the document row
-- had no lifecycle: an upload whose indexing failed looked identical to
-- one that was fully searchable.
--
-- This migration adds both, reusing the existing account-scoped tables
-- (no parallel schema, no new tenancy concept):
--
--   * Private Storage bucket `knowledge-base` holding the original
--     files under `{account_id}/{document_id}/{filename}`.
--     NOTE: this CRM has no `workspace_id` / `agents` table — the
--     tenancy key is `accounts.id` and the assistant is account-level
--     (`ai_configs`), so the path's first segment is the account and
--     the second is the document. That mirrors the avatars bucket
--     convention from migration 008.
--
--   * Columns on `ai_knowledge_documents`:
--       storage_path   text    — object path inside the bucket (NULL for
--                                rows uploaded before 061, or when 061
--                                was not yet applied)
--       file_size      bigint  — original file size in bytes
--       mime_type      text    — browser-reported content type
--       status         text    — 'uploading' | 'processing' | 'ready'
--                                | 'error' (default 'ready' backfills
--                                every existing row: they are all either
--                                searchable or explicitly failed via
--                                Reindex)
--       error_message  text    — why the document is in 'error'
--
-- RLS: the tables keep their existing policies (030/032). The NEW
-- policies below guard `storage.objects` for this bucket only, keyed on
-- the first path segment being the caller's account — same pattern as
-- the avatars bucket, so a member of one account can never read or
-- delete another account's knowledge files. The membership check goes
-- through `knowledge_storage_account()`, an exception-safe extractor,
-- so a path whose first segment is not a UUID degrades to "not a
-- knowledge object" instead of raising inside a policy evaluation and
-- breaking unrelated storage traffic.
--
-- All service code calls Storage from the server routes with the
-- signed-in admin's (RLS) client — the service-role key never reaches
-- the browser, and every privileged parse stays server-side.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. Private bucket. 16 MB matches MAX_FILE_BYTES in
--    src/app/api/ai/knowledge/upload/route.ts; no allowed_mime_types
--    allow-list because the route already validates extensions and
--    browsers report inconsistent MIME types for .docx/.xlsx.
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('knowledge-base', 'knowledge-base', FALSE, 16777216)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit;

-- ============================================================
-- 2. Path → account extractor for the storage policies.
--
-- SECURITY INVOKER + STABLE, and never raises: a non-UUID first
-- segment (any other bucket's layout) simply returns NULL, which
-- `is_account_member(NULL)` evaluates to false. That matters because
-- a policy expression's AND evaluation order is not guaranteed — the
-- function must be safe to call for EVERY row of storage.objects, not
-- just knowledge-base ones.
-- ============================================================
CREATE OR REPLACE FUNCTION public.knowledge_storage_account(object_name text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  first_segment text;
BEGIN
  first_segment := (string_to_array(object_name, '/'))[1];
  IF first_segment IS NULL
     OR first_segment !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  RETURN first_segment::uuid;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END;
$$;

-- Default PUBLIC EXECUTE is kept deliberately: the function exposes
-- nothing (a UUID parsed out of a path the caller can already see), and
-- revoking it would only risk breaking the policy for roles nobody has
-- enumerated (dashboard, future workers).

-- ============================================================
-- 3. Document columns.
-- ============================================================
ALTER TABLE ai_knowledge_documents
  ADD COLUMN IF NOT EXISTS storage_path text,
  ADD COLUMN IF NOT EXISTS file_size bigint,
  ADD COLUMN IF NOT EXISTS mime_type text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ready',
  ADD COLUMN IF NOT EXISTS error_message text;

-- Guarded by name (DO block) because Postgres has no
-- `ADD CONSTRAINT IF NOT EXISTS`, and this migration must re-run cleanly.
DO $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname = 'ai_knowledge_documents_status_check'
          AND conrelid = 'public.ai_knowledge_documents'::regclass
     ) THEN
    ALTER TABLE ai_knowledge_documents
      ADD CONSTRAINT ai_knowledge_documents_status_check
      CHECK (status IN ('uploading', 'processing', 'ready', 'error'));
  END IF;
END
$$;

-- ============================================================
-- 4. Storage policies — scoped to this bucket AND to the caller's
--    account folder. Drop-if-exists, mirroring migration 008.
--
--    SELECT: any member (the server may stream the original back).
--    INSERT/DELETE: admin+, matching the table's own RLS (the upload
--    and delete routes already requireRole('admin')).
--    UPDATE: omitted on purpose — knowledge files are immutable; a
--    re-upload is a new document row.
-- ============================================================
DROP POLICY IF EXISTS "knowledge base files are readable by account members"
  ON storage.objects;
CREATE POLICY "knowledge base files are readable by account members"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'knowledge-base'
    AND public.is_account_member(public.knowledge_storage_account(name))
  );

DROP POLICY IF EXISTS "knowledge base files are writable by account admins"
  ON storage.objects;
CREATE POLICY "knowledge base files are writable by account admins"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'knowledge-base'
    AND public.is_account_member(
          public.knowledge_storage_account(name),
          'admin'
        )
  );

DROP POLICY IF EXISTS "knowledge base files are deletable by account admins"
  ON storage.objects;
CREATE POLICY "knowledge base files are deletable by account admins"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'knowledge-base'
    AND public.is_account_member(
          public.knowledge_storage_account(name),
          'admin'
        )
  );
