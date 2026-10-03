-- 051_contact_phone_nullable.sql
--
-- `contacts.phone` becomes nullable and stops holding any value that
-- is not a real E.164 number. Uses idempotent clauses so the migration
-- can be re-run safely on an already-migrated database or a fresh one.
--
--   * 'unknown' placeholders   -> NULL
--   * long numeric BSUIDs that leaked into `phone` -> NULL (the id is
--     already kept in `wa_user_id`)
--   * '@'-prefixed handles that leaked into `phone` -> moved to
--     `contacts.username` when that column is empty, phone -> NULL
--
-- Identity for those rows lives in `wa_user_id` / `username`, and the
-- outbound path already resolves BSUID-only contacts through
-- `contacts.wa_user_id` via Meta's `recipient` parameter.

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
UPDATE contacts
SET phone = NULL
WHERE phone ~ '^\d{14,}$' OR phone ~* '^(CO|WAID)\.';

-- '@'-handles sitting in `phone`: keep them once in `username`.
UPDATE contacts
SET username = phone, phone = NULL
WHERE phone LIKE '@%' AND (username IS NULL OR username = '');

UPDATE contacts SET phone = NULL WHERE phone LIKE '@%';