-- ============================================================
-- 043_citas_meet_link.sql — Meet conference link on citas
--
-- agendar_cita now creates a Google Meet conference alongside the
-- Calendar event (conferenceDataVersion 1, hangoutsMeet). The
-- generated `hangoutLink` is persisted here so the CRM, the agenda
-- and calendario pages, and the WhatsApp confirmation reply all
-- have a stable link to show the customer.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE citas
  ADD COLUMN IF NOT EXISTS meet_link text;
