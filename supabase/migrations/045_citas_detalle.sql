-- ============================================================
-- 045_citas_detalle.sql — Event detail fields on citas
--
-- The /calendario agenda page and the event modal need the same
-- information Google Calendar holds for the event: the title the
-- agent gave it (summary), the description, and the invited
-- guests (attendees). agendar_cita persists them here right after
-- the event is created (migration 042/043 already store the Meet
-- link); the dashboard then renders them without extra Google
-- round-trips.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE citas
  ADD COLUMN IF NOT EXISTS summary text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS attendees jsonb;