-- 052_store_meta_payload.sql
--
-- Almacena el payload JSON completo que entrega Meta Cloud API v26.0 en cada
-- webhook entrante, para preservar toda la información de identificación
-- (wa_id, user_id, profile.username, display_name, phone_number_id, etc.).
-- También aclara columnas dedicadas para búsquedas rápidas sin tener que
-- parsear el JSON cada vez.

-- -----------------------------------------------------
-- 1. Columna raw_meta_payload en contacts (JSONB, nullable)
-- -----------------------------------------------------
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS raw_meta_payload JSONB;

-- Índice GIN para búsquedas parciales dentro del JSON si algún día se
-- necesita; mantiene el tamaño bajo al estar opcional.
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
-- 3. Columnas clasificadas en contacts (opcionales, para acceso directo).
--    Se rellenan al procesar el webhook; si ya existen no se sobrescribe
--    información más antigua y válida.
-- -----------------------------------------------------
-- phone real E.164 (solo si viene en formato telefónico legítimo)
UPDATE contacts
   SET phone = ((raw_meta_payload->'entry'->0->'changes'->0->'value'->'contacts'->0->>'profile'->>'phone')
                  ::text)
 WHERE raw_meta_payload IS NOT NULL
   AND phone IS NULL
   AND (raw_meta_payload->'entry'->0->'changes'->0->'value'->'contacts'->0->>'profile'->>'phone')::text ~ '^\+?[1-9]\d{1,14}$';

-- BSUID / user_id técnico (puede venir con prefijo 'CO.' o numérico puro)
UPDATE contacts
   SET wa_user_id = NULLIF(
             NULLIF(
               (raw_meta_payload->'entry'->0->'changes'->0->'value'->'contacts'->0->>'wa_id')
               ::text
             ),
             ''
           )
 WHERE raw_meta_payload IS NOT NULL
   AND wa_user_id IS NULL;

-- @username del perfil
UPDATE contacts
   SET username = NULLIF(
             NULLIF(
               (raw_meta_payload->'entry'->0->'changes'->0->'value'->'contacts'->0->>'profile'->>'username')
               ::text
             ),
             ''
           )
 WHERE raw_meta_payload IS NOT NULL
   AND username IS NULL;

-- Nombre display del perfil
UPDATE contacts
   SET display_name = NULLIF(
             NULLIF(
               (raw_meta_payload->'entry'->0->'changes'->0->'value'->'contacts'->0->>'profile'->>'name')
               ::text
             ),
             ''
           )
 WHERE raw_meta_payload IS NOT NULL
   AND display_name IS NULL;

-- phone_number_id de la línea de negocios
UPDATE contacts
   SET phone_number_id = NULLIF(
             NULLIF(
               (raw_meta_payload->'entry'->0->'changes'->0->'value'->'metadata'->>'phone_number_id')
               ::text
             ),
             ''
           )
 WHERE raw_meta_payload IS NOT NULL
   AND phone_number_id IS NULL;

-- -----------------------------------------------------
-- 4. Mismo saneado en messages (solo las columnas que allí son útiles)
-- -----------------------------------------------------
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS wa_id TEXT;
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS user_id_txt TEXT;
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS profile_username TEXT;
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS display_name_msg TEXT;
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS phone_number_id_msg TEXT;

-- Extraer de entry.changes.value igual que en contacts
UPDATE messages
   SET wa_id = NULLIF(
             NULLIF(
               (raw_meta_payload->'entry'->0->'changes'->0->'value'->>'wa_id')
               ::text
             ),
             ''
           )
 WHERE raw_meta_payload IS NOT NULL
   AND wa_id IS NULL;

UPDATE messages
   SET user_id_txt = NULLIF(
             NULLIF(
               (raw_meta_payload->'entry'->0->'changes'->0->'value'->>'user_id')
               ::text
             ),
             ''
           )
 WHERE raw_meta_payload IS NOT NULL
   AND user_id_txt IS NULL;

UPDATE messages
   SET profile_username = NULLIF(
             NULLIF(
               (raw_meta_payload->'entry'->0->'changes'->0->'value'->'contacts'->0->>'profile'->>'username')
               ::text
             ),
             ''
           )
 WHERE raw_meta_payload IS NOT NULL
   AND profile_username IS NULL;

UPDATE messages
   SET display_name_msg = NULLIF(
             NULLIF(
               (raw_meta_payload->'entry'->0->'changes'->0->'value'->'contacts'->0->>'profile'->>'name')
               ::text
             ),
             ''
           )
 WHERE raw_meta_payload IS NOT NULL
   AND display_name_msg IS NULL;

UPDATE messages
   SET phone_number_id_msg = NULLIF(
             NULLIF(
               (raw_meta_payload->'entry'->0->'changes'->0->'value'->'metadata'->>'phone_number_id')
               ::text
             ),
             ''
           )
 WHERE raw_meta_payload IS NOT NULL
   AND phone_number_id_msg IS NULL;

-- -----------------------------------------------------
-- 5. Comentarios para documentación
-- -----------------------------------------------------
COMMENT ON COLUMN contacts.raw_meta_payload IS 'Payload JSON completo recibido de Meta Cloud API v26.0 en el webhook entrante. Preserva wa_id, user_id, profile.username, display_name, phone_number_id y cualquier otro campo.';
COMMENT ON COLUMN messages.raw_meta_payload IS 'Payload JSON completo del mensaje entrante asociado.';
COMMENT ON COLUMN contacts.phone IS 'Teléfono E.164 si estaba presente y era un número real; null si el remitente llegó por BSUID o username.';
COMMENT ON COLUMN contacts.wa_user_id IS 'Business-Scoped User ID (BSUID) o user_id de Meta, con o sin prefijo "CO.". Fuente: raw_meta_payload o wa_id entrante.';
COMMENT ON COLUMN contacts.username IS '@username público del perfil de WhatsApp, si fue enviado por Meta.';
COMMENT ON COLUMN contacts.display_name IS 'Nombre visible mostrado en el perfil de WhatsApp.';
COMMENT ON COLUMN contacts.phone_number_id IS 'ID de la línea de negocios de Meta asociada a este contacto.';