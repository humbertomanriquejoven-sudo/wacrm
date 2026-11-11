-- 077_inbound_pipeline_indexes.sql
-- Covering indexes for the hot reads on the inbound/auto-reply path.
-- All are idempotent so re-running this migration is safe.

-- Thread history + last-message lookup:
--   WHERE conversation_id = ? ORDER BY created_at DESC LIMIT n
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at
  ON messages (conversation_id, created_at DESC);

-- Anti-duplicate / sender-filtered history:
--   WHERE conversation_id = ? AND sender_type = ? ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_messages_conversation_sender_created_at
  ON messages (conversation_id, sender_type, created_at DESC);

-- Follow-up scheduling guards:
--   WHERE contact_id = ? AND type = ? AND status IN (...)
CREATE INDEX IF NOT EXISTS idx_follow_ups_contact_type_status
  ON follow_ups (contact_id, type, status);

-- Pending follow-up lookup inside a thread:
--   WHERE conversation_id = ? AND status = ? ORDER BY execute_at
CREATE INDEX IF NOT EXISTS idx_follow_ups_conversation_status_execute_at
  ON follow_ups (conversation_id, status, execute_at);
