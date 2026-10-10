-- ============================================================
-- Canonical bump_conversation_on_inbound (re-runnable)
-- ============================================================
-- The webhook always calls bump_conversation_on_inbound with the 3-arg
-- signature (p_conversation_id, p_last_message_text, p_last_inbound_wamid).
-- Migration 072 introduced that signature by dropping the 2-arg function and
-- re-creating it with a DEFAULT for the third argument; if 072 was not applied
-- to a database, the deployment still carries the ORIGINAL 2-arg function from
-- migration 037 and the 3-arg call fails with
-- `function bump_conversation_on_inbound does not exist` (42883 / PGRST202).
--
-- This migration is a re-runnable guarantee: it makes the 3-arg signature
-- canonical regardless of which earlier migrations were actually applied.
-- It is idempotent (ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE FUNCTION /
-- DROP FUNCTION IF EXISTS), so reapplying it is always a no-op.
-- ============================================================

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_inbound_wamid TEXT;

COMMENT ON COLUMN public.conversations.last_inbound_at IS
  'Timestamp of the most recent inbound (customer) message. Stamped atomically by bump_conversation_on_inbound. Distinct from last_message_at, which both directions write.';

COMMENT ON COLUMN public.conversations.last_inbound_wamid IS
  'Meta wamid of the most recent inbound message. Used as the CASO B anchor: context.message_id for an opaque wa_id destination.';

-- Best-effort backfill for existing threads (no wamid is recoverable here).
UPDATE public.conversations
SET last_inbound_at = last_message_at
WHERE last_inbound_at IS NULL
  AND last_message_at IS NOT NULL;

-- Drop the legacy 2-arg overload from migration 037 so a 3-arg call never
-- hits an arity mismatch; the DEFAULT below still accepts 2-arg callers.
DROP FUNCTION IF EXISTS public.bump_conversation_on_inbound(UUID, TEXT);

CREATE OR REPLACE FUNCTION public.bump_conversation_on_inbound(
  p_conversation_id UUID,
  p_last_message_text TEXT,
  p_last_inbound_wamid TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE conversations
  SET unread_count       = COALESCE(unread_count, 0) + 1,
      last_message_text  = p_last_message_text,
      last_message_at    = NOW(),
      last_inbound_at    = NOW(),
      last_inbound_wamid = COALESCE(p_last_inbound_wamid, last_inbound_wamid),
      updated_at         = NOW()
  WHERE id = p_conversation_id;
$$;

-- Only the service role (webhook) calls this. Lock everyone else out.
REVOKE ALL ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT, TEXT) TO service_role;