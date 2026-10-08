-- ============================================================
-- 070_follow_up_timer_constraints_reconcile.sql — re-assert the four
-- CHECK constraints the follow-up / response-wait timers run on.
--
-- WHY THIS EXISTS.
--
-- 062-069 built these two tables incrementally, and 069 already re-asserts
-- every constraint — but the applied prefix on the LIVE database cannot be
-- probed from the application: PostgREST never exposes CHECK definitions,
-- and 067-069 add no new columns to tell them apart (column probes only
-- prove the remote is at least at the 066 layout). A constraint left at an
-- older revision is exactly how scheduling dies silently: the INSERT trips
-- the CHECK, the worker swallows it into `{ scheduled: false }`, the route
-- still answers success, and the agent's green toast is followed by an
-- empty `follow_ups` table.
--
-- This file is the reconciliation pass, constraints only: it drops
-- whichever version of each CHECK currently exists — matched BY CONTENT,
-- the style of 063 / 067 / 068 / 069 — and re-adds the definitive literal
-- set the code writes. Every statement is idempotent; a re-run is a no-op.
-- Each block is guarded with `to_regclass`, so unlike 069 it also runs
-- standalone on a database where the tables do not exist yet (they are
-- created by 062 / 064).
--
-- `follow_ups.type` keeps 069's wide literal set ('10m', '24h',
-- 'follow_up', 'response_wait'). The app layer derives strict stages —
-- `followUpTypeForDelay` on the schedule action, `isStrictFollowUpType`
-- inside `scheduleFollowUp` / `scheduleManualFollowUp` — but a
-- not-yet-rotated instance in a rolling deploy may still forward the
-- legacy 'follow_up' name, and a CHECK rejection there is precisely the
-- silent-drop bug this family of migrations exists to kill.
-- ============================================================

-- 1. `follow_ups.type` — every value any shipped writer emits (062 → 069).
DO $$
DECLARE
  c record;
BEGIN
  IF to_regclass('public.follow_ups') IS NULL THEN
    RETURN;
  END IF;

  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.follow_ups'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%''10m''%'
  LOOP
    EXECUTE format('ALTER TABLE public.follow_ups DROP CONSTRAINT %I', c.conname);
  END LOOP;

  EXECUTE 'ALTER TABLE public.follow_ups ADD CONSTRAINT follow_ups_type_check
             CHECK ("type" IN (''10m'', ''24h'', ''follow_up'', ''response_wait''))';
END $$;

-- 2. `follow_ups.status` — the claim lifecycle the runner depends on (067).
DO $$
DECLARE
  c record;
BEGIN
  IF to_regclass('public.follow_ups') IS NULL THEN
    RETURN;
  END IF;

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

  EXECUTE 'ALTER TABLE public.follow_ups ADD CONSTRAINT follow_ups_status_check
             CHECK (status IN (''pending'', ''processing'', ''completed'', ''cancelled'', ''no_response''))';
END $$;

-- 3. `response_wait_timers.status` — same claim lifecycle (067).
DO $$
DECLARE
  c record;
BEGIN
  IF to_regclass('public.response_wait_timers') IS NULL THEN
    RETURN;
  END IF;

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

  EXECUTE 'ALTER TABLE public.response_wait_timers ADD CONSTRAINT response_wait_timers_status_check
             CHECK (status IN (''active'', ''processing'', ''completed'', ''cancelled'', ''no_response''))';
END $$;

-- 4. `response_wait_timers.cancelled_reason` — includes 'not_handle' (067).
DO $$
DECLARE
  c record;
BEGIN
  IF to_regclass('public.response_wait_timers') IS NULL THEN
    RETURN;
  END IF;

  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.response_wait_timers'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%cancelled_reason%'
  LOOP
    EXECUTE format('ALTER TABLE public.response_wait_timers DROP CONSTRAINT %I', c.conname);
  END LOOP;

  EXECUTE 'ALTER TABLE public.response_wait_timers ADD CONSTRAINT response_wait_timers_cancelled_reason_check
             CHECK (cancelled_reason IS NULL
                    OR cancelled_reason IN (''inbound'', ''anti_race'', ''manual'', ''not_handle''))';
END $$;
