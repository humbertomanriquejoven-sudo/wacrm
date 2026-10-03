-- ============================================================
-- 050_message_sender_identity.sql
--
-- El webhook sólo recibe el teléfono del remitente cuando Meta lo
-- conoce. Si el usuario escribe desde un número no registrado, el payload
-- trae un BSUID en su lugar y ese BSUID es lo que queda en
-- `contacts.phone`. La fila de contacto queda inservible para enviar.
--
-- Pero el historial de la conversación no tiene por qué perder lo que
-- Meta sí mandó. Esta columna guarda, en cada mensaje entrante, la
-- dirección tal como llegó (`message.from`): el número real cuando
-- existe, el BSUID cuando no.
--
-- Para qué sirve:
--   * Cuando el contacto nunca fellow una fila nueva (mismo BSUID), esta
--     columna es el único sitio donde puede quedar un E.164 real que el
--     webhook sí vio en otro momento. El resolver lo consulta para
--     recuperar un destino válido en vez de rendirse.
--   * Es evidencia auditable: queda registro de qué dirección recibió
--     Meta en cada mensaje, aunque el contacto se haya reparado o
--     fusionado después.
--
-- Es un snapshot del momento de la entrega y NUNCA se reescribe: si un
-- operador corrige el teléfono del contacto, el historial conserva lo que
-- Meta realmente dijo. Por eso `findRecoverablePhone` prefiere el valor
-- actual del contacto y sólo usa esta columna como respaldo.
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS sender_phone TEXT;

COMMENT ON COLUMN messages.sender_phone IS
  'Dirección del remitente tal como llegó en el webhook (E.164 o BSUID). Snapshot inmutable; nunca se reescribe al corregir el contacto.';

-- El resolver busca el último E.164 conocido al recorrer los mensajes de
-- las conversaciones del contacto. Índice parcial sobre las conversaciones
-- del propio contacto no es posible aquí (messages no tiene account_id),
-- así que se indexa el valor no nulo para que el filtro de "sólo números
-- que sirven" se resuelva en índice y no con un seq scan de la tabla.
CREATE INDEX IF NOT EXISTS idx_messages_sender_phone
  ON messages (sender_phone)
  WHERE sender_phone IS NOT NULL;