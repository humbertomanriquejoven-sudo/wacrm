-- ============================================================
-- 042_ai_reply_raise_limit.sql — Raise max auto-replies cap to 99999
--
-- Updates the CHECK constraint to allow values up to 99999 and
-- changes the column default from 3 to 9999.
-- ============================================================

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_auto_reply_max_per_conversation_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_auto_reply_max_per_conversation_check
    CHECK (auto_reply_max_per_conversation >= 0 AND auto_reply_max_per_conversation <= 99999);

ALTER TABLE ai_configs
  ALTER COLUMN auto_reply_max_per_conversation SET DEFAULT 9999;
