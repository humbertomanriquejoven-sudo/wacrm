-- 052_store_meta_payload.sql
--
-- Almacena el payload JSON completo que entrega Meta Cloud API v26.0 en cada
-- webhook entrante, para preservar toda la información de identificación
-- (wa_id, user_id, profile.username, display_name, phone_number_id, etc.).
-- Las columnas clasificadas permiten búsquedas rápidas sin tener que parsear
-- el JSON cada vez.

-- -----------------------------------------------------
-- 1. Columna raw_meta_payload en contacts (JSONB, nullable)
-- -----------------------------------------------------
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS raw_meta_payload JSONB;

-- Índice GIN para búsquedas parciales dentro del JSON.
CREATE INDEX IF NOT EXISTS idx_contacts_raw_meta_gin
  ON contacts USING GIN (raw_meta_payload);

-- -----------------------------------------------------
-- 2. Columna raw_meta_payload en messages (JSONB, nullable)
-- -----------------------------------------------------
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS raw_meta_payload JSONB;

CREATE INDEX IF NOT EXISTS idx_messages_raw_meta_gin
  ON messages USING GIN (raw_meta_payload);

-- -----------------------------------------------------
-- 3. Comentarios para documentación
-- -----------------------------------------------------
COMMENT ON COLUMN contacts.raw_meta_payload IS 'Payload JSON completo recibido de Meta Cloud API v26.0 en el webhook entrante. Preserva wa_id, user_id, profile.username, display_name, phone_number_id y cualquier otro campo.';
COMMENT ON COLUMN messages.raw_meta_payload IS 'Payload JSON completo del mensaje entrante asociado.';