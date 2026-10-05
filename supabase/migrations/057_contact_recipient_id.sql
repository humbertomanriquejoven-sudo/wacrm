-- 057_contact_recipient_id.sql
--
-- `contacts.recipient_id` está declarada en el tipo `Contact` como el
-- "identificador alternativo" de Meta, y dos consultas vivas la piden:
--
--   - `broadcast-resume.ts` (POST /api/whatsapp/broadcast/[id]/resume)
--   - `meta-send.ts`        (resolución de identidad en el webhook)
--
-- Pero ninguna migración creaba la columna: 053 añade display_name, wa_id,
-- phone_number_id e identity_type; NO recipient_id. PostgREST rechazaba ambas
-- consultas con 42703 "column does not exist", lo que en resume se traducía
-- en `BroadcastError('internal', 'Failed to load recipients', 500)`.
--
-- Aquí se añade de forma idempotente, para que esas proyecciones resuelvan y
-- la rama de fallback `recipient_id` de `resolveBroadcastAddress` /
-- `resolveBestRecipient` tenga una columna real detrás.
--
-- Seguro de reejecutar. No hace backfill: ningún código escribe
-- `recipient_id` todavía, así que las filas existentes quedan en NULL y los
-- resolvers siguen cayendo a la siguiente fuente (phone → wa_id → BSUID →
-- username), que es exactamente el comportamiento anterior.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS recipient_id TEXT;

-- Scoped como sus columnas hermanas de identidad, para que una búsqueda por
-- este identificador nunca cruce cuentas.
CREATE INDEX IF NOT EXISTS idx_contacts_recipient_id
  ON contacts (account_id, recipient_id)
  WHERE recipient_id IS NOT NULL AND recipient_id <> '';