-- Post-migration assertions for the CI job in
-- `.github/workflows/migrations.yml`.
--
-- `supabase db reset` already fails on any statement Postgres rejects,
-- so this is not about syntax. It's about the quieter failure: a
-- migration that applies cleanly and does nothing. Every DDL statement
-- in this repo is guarded with IF NOT EXISTS / ON CONFLICT so the files
-- can be re-run safely, and that same guard turns a typo'd object name
-- into a silent no-op with a green checkmark.
--
-- Keep this thin. It is a smoke test for "did the migrations actually
-- build the schema", not a spec of it — asserting every column here
-- would just be the migrations restated in a second place, drifting.
DO $$
BEGIN
  -- The core tables, from 001.
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'public.messages is missing — migrations did not apply';
  END IF;
  IF to_regclass('public.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION 'public.whatsapp_config is missing — migrations did not apply';
  END IF;

  -- Supabase provides the storage schema; migrations 016/020/023 write
  -- to it. If it is absent the bucket migrations silently accomplish
  -- nothing, which is precisely the case a plain "no errors" run hides.
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION
      'storage.buckets is missing — the storage schema was not available when the bucket migrations ran';
  END IF;

  -- Buckets are UPSERTed, so their absence means the INSERT never ran.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media') THEN
    RAISE EXCEPTION 'the chat-media bucket row was not created (migration 023)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'flow-media') THEN
    RAISE EXCEPTION 'the flow-media bucket row was not created (migration 016)';
  END IF;

  -- Account scoping (017) is load-bearing for every RLS policy.
  IF to_regclass('public.accounts') IS NULL THEN
    RAISE EXCEPTION 'public.accounts is missing — migration 017 did not apply';
  END IF;

  -- The auto-reply slot claim (029/031/046). Both halves have shipped
  -- silent "the bot just never answers" bugs: a missing function, and a
  -- SECURITY DEFINER function that exists but that service_role may not
  -- CALL (EXECUTE was never granted — issue #345). The webhook runs under
  -- service_role, so a missing grant is invisible to every other check here.
  IF to_regprocedure('public.claim_ai_reply_slot(uuid, integer)') IS NULL THEN
    RAISE EXCEPTION 'public.claim_ai_reply_slot(uuid, integer) is missing';
  END IF;
  IF NOT has_function_privilege(
       'service_role',
       'public.claim_ai_reply_slot(uuid, integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION
      'service_role may not EXECUTE claim_ai_reply_slot — the auto-reply will silently never send (issue #345)';
  END IF;

  -- The knowledge base's optional columns (055). These are the one pair the
  -- app probes for and degrades around, so an unapplied 055 is invisible in
  -- the UI: uploads still succeed, they just silently lose filename/source_type.
  -- That is exactly the "applies cleanly and does nothing" failure this file
  -- exists to catch, so it gets an explicit assertion.
  IF NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ai_knowledge_documents'
          AND column_name = 'filename'
     ) THEN
    RAISE EXCEPTION
      'ai_knowledge_documents.filename is missing — migration 055 did not apply; uploads lose their file name';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ai_knowledge_documents'
          AND column_name = 'source_type'
     ) THEN
    RAISE EXCEPTION
      'ai_knowledge_documents.source_type is missing — migration 055 did not apply';
  END IF;

  RAISE NOTICE 'schema verification passed';
END
$$;

-- Two things this file has already been burned by, both verified in CI
-- rather than assumed:
--
-- 1. It must contain EXACTLY ONE statement. `supabase db query --file`
--    sends the whole file as a prepared statement, and a second
--    top-level statement fails with the distinctly unhelpful "cannot
--    insert multiple commands into a prepared statement" (commit
--    f91a6c8). Add assertions INSIDE the DO block above; do not append
--    a second one.
--
-- 2. A RAISE in here really does fail the job. A deliberately false
--    assertion (commit 42c7db0, run 31579334056) surfaced as
--    `failed to execute query: error: ...` and exited 1. This is not a
--    decorative green tick.
