-- ============================================================
-- 069_follow_up_type_and_status_reconcile.sql — widen `follow_ups.type`
--                       so EVERY writer can persist a row, whatever era
--                       of the code path produced it.
--
-- WHY THIS EXISTS.
--
-- `follow_ups.type` was born in 062 as `CHECK (type IN ('10m'))`, widened
-- by 063 to `IN ('10m', '24h')`. The inbox `schedule` action, however, used
-- to forward the raw action name as the type, so a manual "+ Programar"
-- attempted `type = 'follow_up'` — a value no version of the constraint
-- ever accepted. The INSERT failed its CHECK, `scheduleManualFollowUp`
-- swallowed the error into `{ scheduled: false }`, and the route answered
-- `{ success: true }` anyway: the agent saw a green toast, the queue stayed
-- empty, and `follow_ups` never grew a single row.
--
-- The app layer now maps every delay to a REAL stage ('10m' / '24h') — see
-- `route.ts` `action === 'schedule'`. This migration is the safety net under
-- that fix: it lets a row written by a not-yet-rotated instance (or by any
-- future legacy caller) land instead of dying on a constraint, so a rolling
-- deploy can never silently drop a reminder again.
--
-- The constraint is dropped and re-added by CONTENT, matching the style of
-- 063 / 067 / 068: those files drop whichever CHECK on the table mentions
-- the old literal set, so a re-run never leaves a stale constraint behind.
-- Every statement is idempotent.
--
-- Also re-asserts the timer schema 062-068 guarantee (tables, switches and
-- status lists) and reloads PostgREST's schema cache, because this migration
-- may be the first one the live database has ever seen.
-- ============================================================

-- 1. `follow_ups.type` — accept every value any shipped writer emits.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.follow_ups'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%''10m''%'
  LOOP
    EXECUTE format('ALTER TABLE public.follow_ups DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.follow_ups
  ADD CONSTRAINT follow_ups_type_check
  CHECK ("type" IN ('10m', '24h', 'follow_up', 'response_wait'));

-- 2. Per-chat / per-account switches (063 / 066 / 068).
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS follow_up_enabled boolean;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS response_wait_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE public.ai_configs
  ADD COLUMN IF NOT EXISTS follow_up_enabled boolean NOT NULL DEFAULT true;

-- 3. `follow_ups` — table + the claim state the runner depends on (062/067).
CREATE TABLE IF NOT EXISTS public.follow_ups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  "type"          text NOT NULL DEFAULT '10m' CHECK ("type" IN ('10m')),
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'completed', 'cancelled', 'no_response')),
  execute_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS follow_ups_status_execute_at_idx
  ON public.follow_ups (status, execute_at);

CREATE INDEX IF NOT EXISTS follow_ups_conversation_status_idx
  ON public.follow_ups (conversation_id, status);

CREATE INDEX IF NOT EXISTS follow_ups_contact_status_idx
  ON public.follow_ups (contact_id, status);

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.follow_ups'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%status%'
       AND pg_get_constraintdef(oid) ILIKE '%''pending''%'
  LOOP
    EXECUTE format('ALTER TABLE public.follow_ups DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.follow_ups
  ADD CONSTRAINT follow_ups_status_check
  CHECK (status IN ('pending', 'processing', 'completed', 'cancelled', 'no_response'));

-- 4. `response_wait_timers` — Timer 2 (064 / 065 / 067).
CREATE TABLE IF NOT EXISTS public.response_wait_timers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'completed', 'cancelled', 'no_response')),
  delay_minutes   integer NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS response_wait_timers_status_expires_at_idx
  ON public.response_wait_timers (status, expires_at);

CREATE INDEX IF NOT EXISTS response_wait_timers_conversation_status_idx
  ON public.response_wait_timers (conversation_id, status);

ALTER TABLE public.response_wait_timers
  ADD COLUMN IF NOT EXISTS cancelled_reason text;

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.response_wait_timers'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%status%'
       AND pg_get_constraintdef(oid) ILIKE '%''active''%'
  LOOP
    EXECUTE format('ALTER TABLE public.response_wait_timers DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.response_wait_timers
  ADD CONSTRAINT response_wait_timers_status_check
  CHECK (status IN ('active', 'processing', 'completed', 'cancelled', 'no_response'));

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.response_wait_timers'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%cancelled_reason%'
  LOOP
    EXECUTE format('ALTER TABLE public.response_wait_timers DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.response_wait_timers
  ADD CONSTRAINT response_wait_timers_cancelled_reason_check
  CHECK (
    cancelled_reason IS NULL
    OR cancelled_reason IN ('inbound', 'anti_race', 'manual', 'not_handle')
  );

-- 5. RLS — account-scoped data class, identical to 062 / 064.
ALTER TABLE public.follow_ups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS follow_ups_select ON public.follow_ups;
CREATE POLICY follow_ups_select ON public.follow_ups
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS follow_ups_insert ON public.follow_ups;
CREATE POLICY follow_ups_insert ON public.follow_ups
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS follow_ups_update ON public.follow_ups;
CREATE POLICY follow_ups_update ON public.follow_ups
  FOR UPDATE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS follow_ups_delete ON public.follow_ups;
CREATE POLICY follow_ups_delete ON public.follow_ups
  FOR DELETE USING (is_account_member(account_id, 'admin'));

ALTER TABLE public.response_wait_timers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS response_wait_timers_select ON public.response_wait_timers;
CREATE POLICY response_wait_timers_select ON public.response_wait_timers
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS response_wait_timers_insert ON public.response_wait_timers;
CREATE POLICY response_wait_timers_insert ON public.response_wait_timers
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS response_wait_timers_update ON public.response_wait_timers;
CREATE POLICY response_wait_timers_update ON public.response_wait_timers
  FOR UPDATE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS response_wait_timers_delete ON public.response_wait_timers;
CREATE POLICY response_wait_timers_delete ON public.response_wait_timers
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- 6. `updated_at` keep-fresh triggers (062 / 064).
CREATE OR REPLACE FUNCTION public.update_follow_ups_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS follow_ups_updated_at ON public.follow_ups;
CREATE TRIGGER follow_ups_updated_at
  BEFORE UPDATE ON public.follow_ups
  FOR EACH ROW
  EXECUTE FUNCTION public.update_follow_ups_updated_at();

CREATE OR REPLACE FUNCTION public.update_response_wait_timers_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS response_wait_timers_updated_at ON public.response_wait_timers;
CREATE TRIGGER response_wait_timers_updated_at
  BEFORE UPDATE ON public.response_wait_timers
  FOR EACH ROW
  EXECUTE FUNCTION public.update_response_wait_timers_updated_at();

-- 7. Force PostgREST to drop its stale schema cache — without this, an
--    instance that was up while these objects were created keeps answering
--    "Could not find the 'follow_up_enabled' column 'conversations' in the
--    schema cache" until someone recycles it. NOTIFY is a no-op when no
--    PostgREST is listening.
NOTIFY pgrst, 'reload schema';
