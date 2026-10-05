-- 051_contact_phone_nullable.sql
--
-- `contacts.phone` becomes nullable and stops holding any value that
-- is not a real E.164 number. Uses idempotent clauses so the migration
-- can be re-run safely on an already-migrated database or a fresh one.
--
--   * 'unknown' placeholders   -> NULL
--   * long numeric BSUIDs that leaked into `phone` -> preserved into
--     `wa_user_id`, then phone -> NULL
--   * '@'-prefixed handles that leaked into `phone` -> moved to
--     `contacts.username` when that column is empty, phone -> NULL
--
-- Identity for those rows lives in `wa_user_id` / `username`, and the
-- outbound path already resolves BSUID-only contacts through
-- `contacts.wa_user_id` via Meta's `recipient` parameter.
--
-- ORDERING HAZARD, and why the preservation step below exists:
-- this migration runs BEFORE 053/057/058, and the step that nulls a BSUID
-- out of `phone` used to assume the id was "already kept in wa_user_id".
-- That is false for any row written before migration 048 introduced that
-- column: there the BSUID existed ONLY in `phone`, so nulling it deleted the
-- contact's sole delivery address. Nothing downstream can recover it —
-- resolveBroadcastAddress reads the id columns and the message history, and
-- a contact whose only inbound predates `messages.sender_phone` (050) is not
-- in the history either. The UPDATE immediately below therefore copies the
-- value into `wa_user_id` FIRST, so the destructive step can no longer lose
-- data. `wa_user_id` is guaranteed to exist here (048 < 051) and is the
-- column resolveBroadcastAddress already reads as a BSUID tier.

-- Idempotent: Drop NOT NULL only if the column exists and is currently NOT NULL.
-- PostgreSQL does not allow ALTER ... DROP NOT NULL on a column that is already
-- nullable, so we wrap it in a conditional block that checks the current state.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'contacts'
      AND column_name = 'phone'
      IS NOT NULL
  ) THEN
    ALTER TABLE contacts ALTER COLUMN phone DROP NOT NULL;
  END IF;
END $$;

UPDATE contacts SET phone = NULL WHERE phone = 'unknown';

-- Numeric/namespaced BSUID shapes still sitting in `phone`.
--
-- Preserve BEFORE nulling, and only into a column that is actually empty:
-- `wa_user_id` may already hold the correct id for a contact that ALSO has a
-- stale copy in `phone`, and overwriting that would be a downgrade. The
-- placeholder 'unknown' is skipped -- it is not an id.
UPDATE contacts
SET wa_user_id = btrim(phone)
WHERE wa_user_id IS NULL
  AND phone IS NOT NULL
  AND btrim(phone) <> ''
  AND lower(btrim(phone)) NOT IN ('unknown', 'undefined', 'null', 'none')
  AND (phone ~ '^\d{14,}$' OR phone ~* '^(CO|WAID|LID)\.');

-- Now it is safe to drop the value from a phone column.
UPDATE contacts
SET phone = NULL
WHERE phone ~ '^\d{14,}$' OR phone ~* '^(CO|WAID)\.';

-- '@'-handles sitting in `phone`: keep them once in `username`.
UPDATE contacts
SET username = phone, phone = NULL
WHERE phone LIKE '@%' AND (username IS NULL OR username = '');

UPDATE contacts SET phone = NULL WHERE phone LIKE '@%';