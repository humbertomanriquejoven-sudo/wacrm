-- ============================================================
-- 073_contacts_recipient_columns.sql — delivery columns for the
-- Contacts table: BSUID, "Dirección de entrega" and "Tipo de envío".
--
-- Why
--   The Contacts table renders three columns that read from
--   `contacts.bsuid`, `contacts.recipient_address` and
--   `contacts.recipient_type`, but none of those columns existed on the
--   table: the webhook stored the BSUID in the legacy `wa_user_id` column
--   and never resolved a single delivery address. Every row therefore
--   rendered "-" for all three, even when the BSUID was already on the row.
--
--   `bsuid` is the canonical name the app now uses. `wa_user_id` is kept in
--   place (and is still written by the webhook) for the outbound address
--   ladders that were built against it, so this migration is purely
--   additive and non-destructive.
--
--   Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS bsuid TEXT;

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS recipient_address TEXT;

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS recipient_type TEXT;

-- Backfill the BSUID for every row the webhook already populated.
UPDATE public.contacts
   SET bsuid = btrim(wa_user_id)
 WHERE (bsuid IS NULL OR bsuid = '')
   AND wa_user_id IS NOT NULL
   AND btrim(wa_user_id) <> '';

-- Backfill the resolved delivery address / type for existing rows using the
-- same rule the webhook applies on every inbound:
--   wa_id present -> recipient_address = wa_id,  recipient_type = 'phone'
--   else bsuid    -> recipient_address = bsuid,  recipient_type = 'bsuid'
-- Meta's 'unknown' placeholder is never a real address and is skipped.
UPDATE public.contacts
   SET recipient_address = COALESCE(
         CASE
           WHEN wa_id IS NOT NULL
            AND btrim(wa_id) <> ''
            AND lower(btrim(wa_id)) <> 'unknown'
           THEN btrim(wa_id)
         END,
         CASE
           WHEN bsuid IS NOT NULL AND btrim(bsuid) <> ''
           THEN btrim(bsuid)
         END
       ),
       recipient_type = CASE
         WHEN wa_id IS NOT NULL
          AND btrim(wa_id) <> ''
          AND lower(btrim(wa_id)) <> 'unknown'
         THEN 'phone'
         WHEN bsuid IS NOT NULL AND btrim(bsuid) <> ''
         THEN 'bsuid'
         ELSE NULL
       END
 WHERE recipient_address IS NULL
   AND recipient_type IS NULL;

COMMENT ON COLUMN public.contacts.bsuid IS
  'Business Scoped User ID (BSUID). Canonical name; mirrors legacy wa_user_id.';
COMMENT ON COLUMN public.contacts.recipient_address IS
  'Resolved delivery address: wa_id when present, otherwise bsuid.';
COMMENT ON COLUMN public.contacts.recipient_type IS
  'Which identifier recipient_address holds: ''phone'' (wa_id) or ''bsuid''.';

CREATE INDEX IF NOT EXISTS idx_contacts_bsuid
  ON public.contacts (account_id, bsuid)
  WHERE bsuid IS NOT NULL AND bsuid <> '';
