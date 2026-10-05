-- 060_broadcast_partial_status.sql
--
-- `broadcasts.status` could only be draft/scheduled/sending/sent/failed, which
-- forced the sender to publish a campaign that had failed recipients as plain
-- `sent`:
--
--   failedCount === totalRecipients ? 'failed' : 'sent'
--
-- One undeliverable recipient out of a thousand, and the dashboard reported a
-- clean success while that person received nothing. That false signal is what
-- hid a real delivery bug: recipients were being dropped in the browser before
-- any request to Meta was made, and the campaign status said everything was
-- fine.
--
-- `partial` states the outcome that actually occurred: at least one recipient
-- was sent AND at least one failed. The check constraint is replaced rather
-- than added to, because PostgreSQL CHECK constraints have no ALTER — and the
-- old definition must keep allowing every value it allowed before, or any
-- INSERT still relying on the original vocabulary would start failing.
--
-- Idempotent: drops and recreates the constraint, so re-running is a no-op.

ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_status_check;

ALTER TABLE broadcasts
  ADD CONSTRAINT broadcasts_status_check
  CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'partial', 'failed'));

-- Post-condition: the new value has to actually be storable, otherwise the
-- sender would start throwing a 23514 on `partial` at the end of every
-- campaign that had a single failure — trading a false success for a crash.
--
-- Read the live constraint rather than trusting that the ALTER above did what
-- it said. `information_schema.check_constraints` carries only
-- constraint_name/constraint_schema, so the table has to be resolved through
-- `pg_constraint`, which is also where the definition text lives.
DO $$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition
    FROM pg_constraint
   WHERE conrelid = 'public.broadcasts'::regclass
     AND conname = 'broadcasts_status_check'
     AND contype = 'c';

  IF definition IS NULL THEN
    RAISE EXCEPTION 'broadcasts_status_check was not created';
  END IF;

  IF position('partial' IN definition) = 0 THEN
    RAISE EXCEPTION
      'broadcasts_status_check does not allow ''partial'' (got: %)', definition;
  END IF;

  -- Every value the original constraint allowed must still be allowed, or an
  -- INSERT written against the old vocabulary would start failing.
  IF definition NOT LIKE '%draft%'
     OR definition NOT LIKE '%scheduled%'
     OR definition NOT LIKE '%sending%'
     OR definition NOT LIKE '%sent%'
     OR definition NOT LIKE '%failed%'
  THEN
    RAISE EXCEPTION
      'broadcasts_status_check dropped a pre-existing status value (got: %)', definition;
  END IF;
END $$;
