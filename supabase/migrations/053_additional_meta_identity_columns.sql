-- 053_additional_meta_identity_columns.sql
--
-- Agrega columnas complementarias de metadatos de Meta Cloud API v26.0 a la tabla 'contacts'.
-- Están diseñadas para ser idempotentes y pueden reejecutarse con seguridad.
--
-- Columnas nuevas:
--   - display_name: Nombre visible del perfil (opcional).
--   - wa_id: ID nativo del contacto en el webhook de Meta (opcional).
--   - phone_number_id: ID de la línea de negocios de WhatsApp (opcional).
--   - identity_type: Categoría técnica del identificador principal ('PHONE_E164', 'BSUID', 'USERNAME', 'LID').

-- -----------------------------------------------------
-- 1. display_name: Nombre visible mostrado en el perfil de WhatsApp.
-- -----------------------------------------------------
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS display_name TEXT;

-- -----------------------------------------------------
-- 2. wa_id: ID nativo del contacto que envía el mensaje.
--    Este es el wa_id "puro" que a veces envía Meta junto al user_id.
-- -----------------------------------------------------
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS wa_id TEXT;

-- -----------------------------------------------------
-- 3. phone_number_id: ID de la línea de negocios (phone_number_id)
--    que recibió el mensaje. Se usa para asociar el mensaje al número
--    correcto en multi-configuración.
-- -----------------------------------------------------
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS phone_number_id TEXT;

-- -----------------------------------------------------
-- 4. identity_type: Categoría técnica del identificador principal que
--    determina cómo se debe enrutar el mensaje saliente.
--    Valores permitidos: 'PHONE_E164', 'BSUID', 'USERNAME', 'LID'.
-- -----------------------------------------------------
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS identity_type TEXT;

-- -----------------------------------------------------
-- 5. Índices para búsquedas rápidas sobre las nuevas columnas.
-- -----------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_contacts_display_name
  ON contacts (account_id, display_name)
  WHERE display_name IS NOT NULL AND display_name <> '';

CREATE INDEX IF NOT EXISTS idx_contacts_wa_id
  ON contacts (account_id, wa_id)
  WHERE wa_id IS NOT NULL AND wa_id <> '';

CREATE INDEX IF NOT EXISTS idx_contacts_phone_number_id
  ON contacts (account_id, phone_number_id)
  WHERE phone_number_id IS NOT NULL AND phone_number_id <> '';

CREATE INDEX IF NOT EXISTS idx_contacts_identity_type
  ON contacts (account_id, identity_type)
  WHERE identity_type IS NOT NULL AND identity_type <> '';