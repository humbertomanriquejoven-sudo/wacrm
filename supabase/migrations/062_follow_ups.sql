-- ============================================================
-- 062_follow_ups.sql — timed auto follow-ups (10 minutes, one per
--                       contact, ever)
--
-- When the WhatsApp auto-reply answers an inbound, a follow-up is
-- scheduled 10 minutes later in case the customer goes quiet. A
-- background runner (`src/lib/whatsapp/follow-up-worker.ts`, driven by
-- the `/api/whatsapp/follow-ups/cron` endpoint or an optional
-- in-process interval) checks the queue, verifies the customer really
-- did NOT reply, and — only then — sends a natural reminder generated
-- by the account's AI provider.
--
-- Design rules (enforced in the app layer, see the worker):
--   * ONE historical follow-up per contact, ever. Once a contact's row
--     reaches `completed` or `no_response`, `scheduleFollowUp` refuses
--     to create another — a customer should never be chased twice.
--   * `account_id` is denormalized (like `ai_knowledge_chunks`, 030) so
--     the runner and RLS never need a join.
--   * `conversation_id` allows the inbound webhook to cancel every
--     PENDING follow-up for the thread the moment the customer replies.
--   * A `type` column keeps room for future delay policies besides the
--     current '10m'.
--
-- RLS: account-scoped data class. Any member may read; only admin+
-- may write. The webhook/runner both run under the service-role client
-- (neither has `auth.uid()`), so RLS guards dashboard reads exactly as
-- it does for `messages` / `ai_configs`.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS follow_ups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  "type"          text NOT NULL DEFAULT '10m' CHECK ("type" IN ('10m')),
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'completed', 'cancelled', 'no_response')),
  execute_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The runner's scan: due + still pending.
CREATE INDEX IF NOT EXISTS follow_ups_status_execute_at_idx
  ON follow_ups (status, execute_at);

-- The webhook's cancel-by-conversation sweep.
CREATE INDEX IF NOT EXISTS follow_ups_conversation_status_idx
  ON follow_ups (conversation_id, status);

-- The scheduleFollowUp unique-limit check (one completed/no_response
-- per contact, ever).
CREATE INDEX IF NOT EXISTS follow_ups_contact_status_idx
  ON follow_ups (contact_id, status);

ALTER TABLE follow_ups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS follow_ups_select ON follow_ups;
CREATE POLICY follow_ups_select ON follow_ups FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS follow_ups_insert ON follow_ups;
CREATE POLICY follow_ups_insert ON follow_ups FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS follow_ups_update ON follow_ups;
CREATE POLICY follow_ups_update ON follow_ups FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS follow_ups_delete ON follow_ups;
CREATE POLICY follow_ups_delete ON follow_ups FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- Keep updated_at fresh on every write.
CREATE OR REPLACE FUNCTION public.update_follow_ups_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS follow_ups_updated_at ON follow_ups;
CREATE TRIGGER follow_ups_updated_at
  BEFORE UPDATE ON follow_ups
  FOR EACH ROW
  EXECUTE FUNCTION public.update_follow_ups_updated_at();