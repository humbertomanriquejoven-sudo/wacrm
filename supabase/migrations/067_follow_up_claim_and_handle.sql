-- ============================================================
-- 067_follow_up_claim_and_handle.sql — atomic claim + @handle gate.
--
-- Two changes that close the "duplicate automated message" bug and the
-- "only @user contacts" rule together:
--
--   1. STATUS 'processing' on BOTH queue tables. The runner now CLAIMS a
--      due row (`pending`/`active` → `processing`) BEFORE generating and
--      sending, so two overlapping sweeps (external cron + the in-process
--      interval) can never both select the same row and both send. The
--      terminal transitions (→ completed / no_response / cancelled) are
--      guarded on `processing`, exactly like the old `pending`/`active`
--      guards.
--
--   2. `cancelled_reason` gains `'not_handle'`: when the runner finds a
--      due row whose contact has NO public @user / @lid handle, it drops
--      the reminder with this reason instead of messaging a phone-only
--      (or bare BSUID) contact — the "solo contactos @user" rule.
--
-- The status CHECK constraints were created anonymously ('living' as
-- `follow_ups_status_check` / `response_wait_timers_status_check`), so the
-- drops match ANY check that mentions the current literal set, exactly like
-- migration 063 does for the type literals. All statements are idempotent.
-- ============================================================

-- 1a. follow_ups.status — add 'processing'.
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

-- 1b. response_wait_timers.status — add 'processing'.
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

-- 2. response_wait_timers.cancelled_reason — accept 'not_handle'.
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