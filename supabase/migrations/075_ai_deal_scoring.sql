-- 075_ai_deal_scoring.sql
--
-- AI-driven lead scoring (0-10) + automatic pipeline movement.
--
-- After the auto-reply bot dispatches a WhatsApp reply, a best-effort
-- analysis pass evaluates the conversation and records a commercial
-- score plus a suggested funnel stage on the contact's ACTIVE deal.
--
-- Design notes:
--   * Scoring NEVER leaks structured analysis into the WhatsApp
--     outbound (outbound is text-only). The evaluation is persisted
--     here, in dedicated nullable columns, so the UI can read it.
--   * Manual notes are never overwritten. The analysis also writes a
--     fenced block into `deals.notes` between explicit delimiters so a
--     human can read it where they already work; `mergeAiNotes` (app
--     layer) strips only a prior AI block and keeps the manual text.
--   * Realtime: the pipelines board subscribes to `deals`, so the table
--     is added to the `supabase_realtime` publication.
--
-- Idempotent: safe to re-run.

-- ============================================================
-- AI columns on deals (all nullable — existing rows stay untouched)
-- ============================================================
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS ai_score SMALLINT,
  ADD COLUMN IF NOT EXISTS ai_temperature TEXT,
  ADD COLUMN IF NOT EXISTS ai_summary TEXT,
  ADD COLUMN IF NOT EXISTS ai_stage_id UUID REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ai_analyzed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_analysis_model TEXT;

-- ai_score is the 0-10 lead score; keep it in range when present.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'deals_ai_score_check' AND conrelid = 'deals'::regclass
  ) THEN
    ALTER TABLE deals
      ADD CONSTRAINT deals_ai_score_check
      CHECK (ai_score IS NULL OR (ai_score >= 0 AND ai_score <= 10));
  END IF;
END $$;

-- Application-level dedupe ("no duplicate active deals per contact")
-- leans on this lookup: account + contact + pipeline + status.
CREATE INDEX IF NOT EXISTS idx_deals_account_contact_status
  ON deals(account_id, contact_id, status);

-- ============================================================
-- Allow the analysis pass to record its own token spend.
-- ai_usage_log.mode was CHECK (mode IN ('auto_reply', 'draft')).
-- ============================================================
ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_mode_check;

ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_mode_check
  CHECK (mode IN ('auto_reply', 'draft', 'deal_analysis'));

-- ============================================================
-- ENABLE REALTIME for deals (idempotent via DO block)
-- ============================================================
-- REPLICA IDENTITY FULL so UPDATE/DELETE events carry the columns the
-- board filters on (pipeline_id) and can refresh without a manual reload.
ALTER TABLE deals REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'deals'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE deals;
  END IF;
END $$;
