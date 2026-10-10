-- 074_clean_unknown_phone.sql
--
-- The webhook used to persist the literal string 'unknown' into
-- `contacts.phone` when Meta disclosed no number for a sender (the column
-- was NOT NULL before migration 051, so a placeholder had to fill it).
-- The placeholder is NOT a deliverable address: it seeded outbound lookups
-- and poisoned the sender id / destination resolution. The webhook now
-- writes SQL NULL (migration 051 made the column nullable), and this
-- migration backfills the legacy rows so the placeholder can never reach
-- the send path again.
--
-- Idempotent: safe to re-run; matches the shape of the 051 cleanup so any
-- stray case variation ('unknown' / 'Unknown' / whitespace) is caught too.

UPDATE contacts
SET phone = NULL
WHERE phone IS NOT NULL
  AND lower(btrim(phone)) = 'unknown';