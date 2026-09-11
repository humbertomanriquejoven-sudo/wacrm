-- ============================================================
-- 042_google_calendar_citas.sql — appointment booking
--
-- Backing store for the AI calendar-booking tools
-- (ver_disponibilidad / agendar_cita / reagendar_cita /
-- cancelar_cita). Each row mirrors a Google Calendar event on
-- the account's shared calendar: the calendar is the source of
-- truth for the event itself, this table records the CRM-side
-- link (contact) plus a stable UUID the WhatsApp/AI flows can
-- address without knowing the provider event id.
--
-- Lifecycle: `estado` is 'confirmada' while the event lives in
-- Google Calendar; cancelar_cita deletes the remote event and
-- flips the row to 'cancelada'. The Google event id is kept so
-- reagendar_cita can PATCH it even from a bare uu_id.
--
-- RLS: operational class mirroring `contact_notes` /
-- `conversations` — any account member may read; agents+ may
-- insert/update/delete. The AI auto-reply path writes through
-- the service-role client (no auth.uid()), so RLS guards the
-- dashboard only.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS citas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  google_event_id text NOT NULL,
  fecha_inicio    timestamptz NOT NULL,
  fecha_fin       timestamptz NOT NULL,
  estado          text NOT NULL DEFAULT 'confirmada'
                  CHECK (estado IN ('confirmada', 'cancelada')),
  motivo          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (google_event_id)
);

CREATE INDEX IF NOT EXISTS citas_account_id_idx
  ON citas (account_id);
CREATE INDEX IF NOT EXISTS citas_contact_id_idx
  ON citas (contact_id);
CREATE INDEX IF NOT EXISTS citas_fecha_inicio_idx
  ON citas (fecha_inicio);

ALTER TABLE citas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS citas_select ON citas;
CREATE POLICY citas_select ON citas FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS citas_insert ON citas;
CREATE POLICY citas_insert ON citas FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS citas_update ON citas;
CREATE POLICY citas_update ON citas FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS citas_delete ON citas;
CREATE POLICY citas_delete ON citas FOR DELETE
  USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON citas;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON citas
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();