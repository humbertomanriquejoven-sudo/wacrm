-- ============================================================
-- 048_contact_identity_identifiers.sql
--
-- Meta ahora puede identificar a un remitente de tres formas, y no
-- siempre las manda todas:
--
--   * `wa_id`        — el número de teléfono (canónico, siempre presente
--                      para mensajes de un número registrado).
--   * `user_id`      — el BSUID (Business-Scoped User ID), un id opaco
--                      por WABA. Aparece cuando el usuario se comunica
--                      por un número no registrado en WhatsApp.
--   * `profile.username` — el @username público.
--
-- El webhook Creates un contacto cuando no puede casar nada con lo
-- existente, y antes de esta migración sólo tenía `phone` donde
-- guardar el identificador. Cuando Meta envía un BSUID en lugar de un
-- número, esa fila quedaba huérfana: `phone` vacío o con un id opaco
-- que luego `sanitizePhoneForMeta` rechaza, así que el envío saliente
-- fallaba aunque el webhook entrante funcionara.
--
-- Estas dos columnas dan a cada contacto un identificador estable y
-- legible, y permiten que el webhook resuelva por cualquiera de los tres
-- antes de insertar una fila duplicada.
-- ============================================================

-- BSUID de Meta. Opcional: sólo los remitentes que llegan por un número
-- no registrado lo traen.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS wa_user_id TEXT;

-- @username público. Opcional: no todos los perfiles lo exponen.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS username TEXT;

-- `phone` es NOT NULL en este esquema (001) y todo el código de envío
-- asume un destinatario, así que no se toca aquí. Lo que garantiza que
-- nunca quede vacío es la normalización del webhook.

-- Índice parcial por BSUID: sólo indexa las filas que realmente lo
-- tienen, así que es barato y sirve de índice único natural (un BSUID
-- identifica a una persona dentro de una WABA).
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_wa_user_id
  ON contacts (account_id, wa_user_id)
  WHERE wa_user_id IS NOT NULL AND wa_user_id <> '';

-- Búsqueda por username. NO único a propósito: dos cuentas distintas
-- pueden compartir un username público, y una colisión aquí sólo debe
-- fusionar dentro de la misma cuenta.
CREATE INDEX IF NOT EXISTS idx_contacts_username
  ON contacts (account_id, username)
  WHERE username IS NOT NULL AND username <> '';

-- ============================================================
-- Saneado de filas huérfanas creadas antes de esta migración.
--
-- Cualquier `phone` que sólo contenga el id opaco de un BSUID (no son
-- dígitos, o son dígitos pero no son un teléfono válido) no sirve como
-- destinatario. Cuando su BSUID está disponible, se promote a `phone`
-- para que el envío saliente tenga algo que usar; si no, se deja como
-- está para que el webhook pueda repararla en el próximo inbound.
-- ============================================================
UPDATE contacts
   SET phone = wa_user_id
 WHERE (phone IS NULL OR phone = '')
   AND wa_user_id IS NOT NULL
   AND wa_user_id <> '';