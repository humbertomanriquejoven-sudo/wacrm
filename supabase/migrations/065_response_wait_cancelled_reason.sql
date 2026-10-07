-- ============================================================
-- 065_response_wait_cancelled_reason.sql — why a wait timer ended.
--
-- "Esperar respuesta" is a ONE-SHOT timer: it either FIRES at
-- 00:00 (status → `completed`, "Acción ejecutada") or gets CANCELLED
-- because the customer replied (status → `cancelled`). The UI needs to
-- tell those two outcomes apart after a refresh, so this migration
-- records WHY a row was cancelled:
--
--   'inbound'   — the inbound webhook cancelled it because the customer
--                 just replied (the critical cancel-by-reply rule).
--   'anti_race' — the runner cancelled it as a race safety net after
--                 detecting a reply that landed around the sweep.
--   'manual'    — an agent cancelled it (API `wait_cancel`; Reset also
--                 re-arms the single ACTIVE row, which overwrites it).
--
-- `completed` rows stay NULL. The app reads this column to render
-- "💬 Cliente respondió (Temporizador cancelado)" vs
-- "✅ Tiempo de espera finalizado (Acción ejecutada)".
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE public.response_wait_timers
  ADD COLUMN IF NOT EXISTS cancelled_reason text
    CHECK (cancelled_reason IS NULL OR cancelled_reason IN ('inbound', 'anti_race', 'manual'));