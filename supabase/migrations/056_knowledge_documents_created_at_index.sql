-- 056: index the knowledge document list for its actual read pattern.
--
-- GET /api/ai/knowledge (and the list reload inside the upload route) read
--   SELECT ... FROM ai_knowledge_documents
--    WHERE account_id = $1
--    ORDER BY created_at DESC
-- Migration 030 indexed `account_id` alone, so Postgres had to filter by
-- account and then sort the surviving rows. The panel is an upload log, so
-- that sort sits directly under the request that renders it.
--
-- DESC matters: a plain `(created_at)` btree is walked backwards for
-- `ORDER BY created_at DESC`, so this matches the query as written.
--
-- Scope note: per-account knowledge bases are small — migration 030 notes
-- they "start empty and grow incrementally" — so this is a cheap safety net
-- rather than a fix for a measured bottleneck. It is here so the list stays
-- flat as an account accumulates documents, not because it is currently
-- slow.
--
-- If the list ever does get large, the index that actually serves this
-- query is the composite `(account_id, created_at DESC)`: it answers the
-- filter and the sort together. That is deliberately NOT created here,
-- because it would supersede the `account_id` index from 030 and dropping an
-- index from a later migration is not a change worth making blindly.

CREATE INDEX IF NOT EXISTS idx_ai_knowledge_docs_created_at
  ON ai_knowledge_documents (created_at DESC);
