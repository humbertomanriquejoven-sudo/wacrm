-- ============================================================
-- 064_response_wait_timers.sql — Timer 2: per-conversation "wait
--                       for the client's reply" countdown.
--
-- The CRM supports TWO fully independent, persistent timers per
-- conversation (`conversation_id`):
--
--   Timer 1 — "follow-up"    → `follow_ups` (migrations 062/063).
--   Timer 2 — "wait reply"   → THIS table.
--
-- Timer 2 counts the minutes the agent wants to wait after the last
-- outbound message before the system proactively nudges the customer
-- again. Unlike Timer 1 it has NO ON/OFF switch: it is armed with
-- `Set/Start` and re-armed with `Reset`, both of which UPSERT the single
-- ACTIVE row so the conversation always has zero or one active timer
-- (no stacking, no duplicated sends, no shared/global state).
--
-- CRITICAL RULE (cancel by reply): the inbound webhook CANCELS the
-- ACTIVE row for the `conversation_id` the moment a real customer
-- message lands (`cancelResponseWaitTimers`). The runner also re-checks
-- the conversation's last message at dispatch time as a race safety net,
-- so a follow-up is never sent to someone who already answered.
--
-- Like follow_ups, every row carries `account_id` (denormalized) for
-- the service-role runner and for RLS, `started_at` + `expires_at` so
-- the UI always renders the DYNAMIC remainder `expires_at - NOW()` (a
-- chat switch or a page refresh can never reset or mix the counters),
-- and `delay_minutes` so a `Reset` can re-arm from the exact value the
-- agent typed.
--
-- RLS: account-scoped data class, identical to follow_ups — any member
-- may read; only admin+ may write. The webhook/runner write via the
-- service-role client (no `auth.uid()`), so RLS guards dashboard reads.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS response_wait_timers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'completed', 'cancelled', 'no_response')),
  delay_minutes   integer NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The runner's scan: due + still active.
CREATE INDEX IF NOT EXISTS response_wait_timers_status_expires_at_idx
  ON response_wait_timers (status, expires_at);

-- The webhook's cancel-by-conversation sweep.
CREATE INDEX IF NOT EXISTS response_wait_timers_conversation_status_idx
  ON response_wait_timers (conversation_id, status);

ALTER TABLE response_wait_timers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS response_wait_timers_select ON response_wait_timers;
CREATE POLICY response_wait_timers_select ON response_wait_timers FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS response_wait_timers_insert ON response_wait_timers;
CREATE POLICY response_wait_timers_insert ON response_wait_timers FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS response_wait_timers_update ON response_wait_timers;
CREATE POLICY response_wait_timers_update ON response_wait_timers FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS response_wait_timers_delete ON response_wait_timers;
CREATE POLICY response_wait_timers_delete ON response_wait_timers FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- Keep updated_at fresh on every write.
CREATE OR REPLACE FUNCTION public.update_response_wait_timers_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS response_wait_timers_updated_at ON response_wait_timers;
CREATE TRIGGER response_wait_timers_updated_at
  BEFORE UPDATE ON response_wait_timers
  FOR EACH ROW
  EXECUTE FUNCTION public.update_response_wait_timers_updated_at();