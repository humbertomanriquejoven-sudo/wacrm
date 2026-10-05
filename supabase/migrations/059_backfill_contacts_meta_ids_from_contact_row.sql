-- 059_backfill_contacts_meta_ids_from_contact_row.sql
--
-- Fill `contacts.wa_id` / `contacts.recipient_id` for contacts that already
-- carry a numerical Meta id somewhere the backfill never looked.
--
-- WHY THIS EXISTS, since 058 already backfills the same two columns:
--
-- 058 read the id out of `messages.raw_meta_payload` and `sender_phone`. It
-- did not read `contacts.wa_user_id`, even though that column is written by
-- the webhook on insert and holds exactly the same id. A contact whose id
-- arrived through `wa_user_id` but whose history had no payload — a brand new
-- conversation, a deleted history, or a payload column that had not been
-- populated yet — was therefore left with `wa_id` and `recipient_id` NULL
-- while a perfectly good BSUID sat one column over.
--
-- Observed on the live database (contact d116e7c4, "Juan Pablo Martinez"):
-- `phone` = 'unknown', `wa_user_id` = '1486998326437295', `wa_id` = NULL,
-- `recipient_id` = NULL, with two inbound messages whose payload did carry
-- `CO.1486998326437295`. resolveBroadcastAddress still reached the BSUID via
-- `wa_user_id`, but the dashboard rejected the recipient earlier than that,
-- on `recipient.phone` alone, so the campaign reported `failed`.
--
-- This reads the contact's own `wa_user_id` FIRST and only then falls back to
-- the newest inbound payload, so it repairs rows that 058 could not see, and
-- it keeps 058's payload extraction as a safety net.
--
-- Idempotent: every write is COALESCE(NULLIF(<col>, '')) so an existing value
-- is never overwritten, and the whole file is safe to re-run against a
-- database restored from a snapshot whose migration ledger already lists 058
-- as applied.

WITH latest AS (
  SELECT DISTINCT ON (cv.contact_id)
         cv.contact_id,
         COALESCE(
           NULLIF(m.raw_meta_payload -> 'message' ->> 'from_user_id', ''),
           NULLIF(m.raw_meta_payload -> 'contact' ->> 'user_id', ''),
           NULLIF(m.raw_meta_payload -> 'entry' -> 0 -> 'changes' -> 0 -> 'value'
                  -> 'messages' -> 0 ->> 'from_user_id', ''),
           NULLIF(m.raw_meta_payload -> 'entry' -> 0 -> 'changes' -> 0 -> 'value'
                  -> 'contacts' -> 0 ->> 'user_id', '')
         ) AS resolved
    FROM conversations cv
    JOIN messages m ON m.conversation_id = cv.id
   WHERE m.sender_type = 'customer'
     AND m.raw_meta_payload IS NOT NULL
   ORDER BY cv.contact_id, m.created_at DESC
),
candidates AS (
  SELECT ct.id,
         COALESCE(
           NULLIF(btrim(ct.wa_user_id), ''),
           NULLIF(btrim(latest.resolved), '')
         ) AS resolved
    FROM contacts ct
    LEFT JOIN latest ON latest.contact_id = ct.id
)
UPDATE contacts ct
   SET wa_id        = COALESCE(NULLIF(btrim(ct.wa_id), ''), candidates.resolved),
       recipient_id = COALESCE(NULLIF(btrim(ct.recipient_id), ''), candidates.resolved),
       updated_at   = now()
  FROM candidates
 WHERE candidates.id = ct.id
   AND candidates.resolved IS NOT NULL
   AND btrim(candidates.resolved) <> ''
   AND (
         COALESCE(btrim(ct.wa_id), '') = ''
      OR COALESCE(btrim(ct.recipient_id), '') = ''
       );

-- Post-condition, as a real assertion rather than a comment. This is the
-- check from the bug report: no contact left with a placeholder phone, a
-- NULL `wa_id`, and an inbound history that proves an id exists.
DO $$
DECLARE
  stranded integer;
BEGIN
  SELECT count(*) INTO stranded
    FROM contacts ct
    JOIN conversations cv ON cv.contact_id = ct.id
    JOIN messages m      ON m.conversation_id = cv.id
   WHERE COALESCE(btrim(ct.wa_id), '') = ''
     AND COALESCE(btrim(ct.recipient_id), '') = ''
     AND m.sender_type = 'customer'
     AND m.raw_meta_payload IS NOT NULL
     AND (
           NULLIF(m.raw_meta_payload -> 'message' ->> 'from_user_id', '') IS NOT NULL
        OR NULLIF(m.raw_meta_payload -> 'contact' ->> 'user_id', '') IS NOT NULL
         );
  IF stranded > 0 THEN
    RAISE EXCEPTION
      '059 left % contact(s) with a provable Meta id but NULL wa_id and NULL recipient_id', stranded;
  END IF;
END $$;
