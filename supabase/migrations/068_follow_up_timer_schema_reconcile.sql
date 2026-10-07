-- ============================================================
-- 068_follow_up_timer_schema_reconcile.sql — guarantee the timer
--                       schema on ANY database state + reload cache.
--
-- WHY THIS EXISTS.
--
-- Production reported a hard stoppage of "Seguimiento automático" and
-- "Esperar respuesta" with:
--
--   Could not find the 'follow_up_enabled' column 'conversations' in the
--   schema cache
--
-- That is PostgREST's "column missing" error, which is really a MESSAGE
-- that one of migrations 062-067 (all of which carry `IF NOT EXISTS`
-- guards) never reached the live database. When that happens the
-- dashboard-toggle, the arm/reset INSERTs and the worker reads all fail
-- in slightly different ways around the same missing columns/tables.
--
-- Rather than ship an "apologetic" 068 that only re-adds
-- `follow_up_enabled`, this migration RECONCILES the complete timer
-- schema so any partially-migrated database is brought to the FINAL
-- shape in one file, then forces PostgREST to reload its schema cache
-- (`NOTIFY pgrst, 'reload schema'`) so the cached error disappears even
-- on a PostgREST that has been up since before the columns existed.
--
-- Every statement is idempotent (IF NOT EXISTS / DO … EXIST guards), so
-- it is safe on a fully-migrated database, on a fresh `db reset`, and on
-- every state in between. It intentionally mirrors 062-067 so nothing
-- depends on the order those files were (or were not) applied.
--
-- What it guarantees, in one pass:
--   * `conversations.follow_up_enabled`      (from 063)
--   * `conversations.response_wait_enabled`  (from 066)
--   * `ai_configs.follow_up_enabled`         (from 063)
--   * `follow_ups` table + type '10m'/'24h' + status 'processing'
--                                         + indexes + RLS + trigger (062/063/067)
--   * `response_wait_timers` table + status 'processing'
--                             + cancelled_reason + indexes + RLS (064/065/067)
--   * PostgREST schema cache reload
-- ============================================================

-- 1. Per-chat / per-account switches -----------------------------------
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS follow_up_enabled boolean;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS response_wait_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE public.ai_configs
  ADD COLUMN IF NOT EXISTS follow_up_enabled boolean NOT NULL DEFAULT true;

-- 2. Timer 1 — `follow_ups` (migration 062) ----------------------------
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

ALTER TABLE public.follow_ups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS follow_ups_select ON public.follow_ups;
CREATE POLICY follow_ups_select ON public.follow_ups FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS follow_ups_insert ON public.follow_ups;
CREATE POLICY follow_ups_insert ON public.follow_ups FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS follow_ups_update ON public.follow_ups;
CREATE POLICY follow_ups_update ON public.follow_ups FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS follow_ups_delete ON public.follow_ups;
CREATE POLICY follow_ups_delete ON public.follow_ups FOR DELETE
  USING (is_account_member(account_id, 'admin'));

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

-- 2b. Final CHECKs (migrations 063 + 067) — drop whichever loose CHECK
-- mentions the OLD literal and re-add the widened one, matching the
-- drop-by-content style of those migrations so a re-run never leaves a
-- stale constraint behind.
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

-- 3. Timer 2 — `response_wait_timers` (migration 064) ------------------
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

ALTER TABLE public.response_wait_timers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS response_wait_timers_select ON public.response_wait_timers;
CREATE POLICY response_wait_timers_select ON public.response_wait_timers FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS response_wait_timers_insert ON public.response_wait_timers;
CREATE POLICY response_wait_timers_insert ON public.response_wait_timers FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS response_wait_timers_update ON public.response_wait_timers;
CREATE POLICY response_wait_timers_update ON public.response_wait_timers FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS response_wait_timers_delete ON public.response_wait_timers;
CREATE POLICY response_wait_timers_delete ON public.response_wait_timers FOR DELETE
  USING (is_account_member(account_id, 'admin'));

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

-- 3b. Final CHECKs (migrations 065 + 067): `cancelled_reason` column +
-- its value list, and `status` widened with 'processing'.
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

-- 4. Force PostgREST to drop its stale schema cache --------------------
-- Without this, an instance that was running WHILE the columns/tables
-- were being created keeps answering "Could not find the
-- 'follow_up_enabled' column 'conversations' in the schema cache" until
-- someone recycles it. NOTIFY is a no-op when no PostgREST listens.
NOTIFY pgrst, 'reload schema';