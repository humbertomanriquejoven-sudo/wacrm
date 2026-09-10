-- ============================================================
-- 041_ai_reply_unlimited.sql — Allow unlimited auto-replies
--
-- Drops the CHECK constraint that forced auto_reply_max_per_conversation
-- between 1 and 20, and updates the claim_ai_reply_slot RPC to treat
-- max_replies = 0 as unlimited (always claims a slot and increments
-- the counter without a cap check).
-- ============================================================

-- Allow 0 (unlimited) in addition to 1-20.
ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_auto_reply_max_per_conversation_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_auto_reply_max_per_conversation_check
    CHECK (auto_reply_max_per_conversation >= 0);

-- Update the RPC: when max_replies is 0, skip the cap check and
-- always increment + return true.
CREATE OR REPLACE FUNCTION public.claim_ai_reply_slot(
  conversation_id uuid,
  max_replies integer
)
RETURNS boolean AS $$
  WITH claimed AS (
    UPDATE conversations
    SET ai_reply_count = ai_reply_count + 1
    WHERE id = conversation_id
      AND (max_replies = 0 OR ai_reply_count < max_replies)
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;
