-- ============================================================
-- conversations.last_inbound_at / last_inbound_wamid
-- ============================================================
-- Rule 2 of the directiva de persistencia: every inbound message must be
-- stamped on the CONVERSATION with
--   * `last_inbound_at`     - when the customer last wrote (server clock,
--                             not the Meta timestamp, so it is monotonic).
--   * `last_inbound_wamid`  - the wamid of that last inbound message.
--
-- `last_message_at` already existed but is written by BOTH directions, so it
-- cannot answer "when did the customer last write?" nor anchor the CASO B
-- `context.message_id` (the last inbound wamid). These two columns are that
-- anchor.
--
-- The atomic inbound bump (`bump_conversation_on_inbound`, migration 037)
-- is recreated to stamp both columns in the SAME UPDATE that bumps unread, so
-- concurrent inbound deliveries cannot lose the anchor to a read-modify-write
-- race. The 2-arg signature is dropped first: a 2-arg call then resolves
-- unambiguously to the new 3-arg function's default. Idempotent: safe to
-- re-run.
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

-- Recreate the inbound bump: one atomic UPDATE that also anchors the inbound.
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
