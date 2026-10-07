-- ============================================================
-- 063_follow_ups_24h_and_toggles.sql — second follow-up stage (24h)
--                       and per-account / per-conversation switches.
--
-- Migration 062 shipped a single 10-minute reminder. This migration:
--
--   1. Widens `follow_ups.type` to accept '24h' as well as '10m' so the
--      runner can chase a silent customer a second time, a day later.
--      The app layer keeps "one follow-up per contact PER TYPE, ever":
--      a 10m that completes schedules the 24h; a 24h that completes (or
--      has no response) closes the contact's budget for good.
--
--   2. Adds `ai_configs.follow_up_enabled` — the account-wide switch the
--      operator flips in Settings → Agent setup. Defaults to TRUE so
--      existing deployments keep their current behaviour.
--
--   3. Adds `conversations.follow_up_enabled` — a per-chat override the
--      agent flips in the inbox. NULL means "inherit the account switch";
--      FALSE turns reminders off for that thread only.
--
-- All statements are idempotent — safe to run multiple times.
-- ============================================================

-- 1. Allow the 24h stage. The CHECK constraint from 062 was created
--    anonymously as `follow_ups_type_check`; drop whichever CHECK on this
--    table mentions the old '10m' value so a future re-run never leaves a
--    stale constraint that still rejects '24h'.
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
  CHECK ("type" IN ('10m', '24h'));

-- 2. Account-wide switch. TRUE for every existing row so nothing changes
--    until an operator turns it off.
ALTER TABLE public.ai_configs
  ADD COLUMN IF NOT EXISTS follow_up_enabled boolean NOT NULL DEFAULT true;

-- 3. Per-conversation override. NULL = inherit the account switch.
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS follow_up_enabled boolean;

-- Runner scan for the 24h stage also benefits from the existing
-- (status, execute_at) index; nothing new is required here.
