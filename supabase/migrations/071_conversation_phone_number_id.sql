-- ============================================================
-- conversations.phone_number_id
-- ============================================================
-- Rule 1 of the WhatsApp recipient engine: the business line that received
-- an inbound message (`metadata.phone_number_id`) is stored on the
-- CONVERSATION, and sender resolution reads it FIRST:
--
--   1. conversation.phone_number_id
--   2. whatsapp_config.phone_number_id
--   3. contacts.phone_number_id (migration 053)
--   4. process env: WHATSAPP_PHONE_NUMBER_ID / META_PHONE_NUMBER_ID
--
-- The webhook (`findOrCreateConversation`) backfills this column on every
-- inbound, so a sender whose DB row or config is stale can still address
-- the exact line the customer wrote to. Idempotent: safe to re-run.
-- ============================================================

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS phone_number_id TEXT;

COMMENT ON COLUMN public.conversations.phone_number_id IS
  'WhatsApp business line (Meta phone_number_id) that received the messages of this conversation. Sender resolution reads it first (rule 1): conversation -> whatsapp_config -> contacts.phone_number_id -> env.';

CREATE INDEX IF NOT EXISTS idx_conversations_phone_number_id
  ON public.conversations (account_id, phone_number_id)
  WHERE phone_number_id IS NOT NULL AND phone_number_id <> '';

-- Backfill from the contact that owns each conversation (best effort).
UPDATE public.conversations c
SET phone_number_id = ct.phone_number_id
FROM public.contacts ct
WHERE c.contact_id = ct.id
  AND (c.phone_number_id IS NULL OR c.phone_number_id = '')
  AND ct.phone_number_id IS NOT NULL
  AND ct.phone_number_id <> '';
