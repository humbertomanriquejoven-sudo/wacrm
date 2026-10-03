-- ============================================================
-- 049_pending_reply_recipient.sql
--
-- Meta no siempre manda el número del remitente. Cuando el usuario escribe
-- desde un número no registrado llega un BSUID en su lugar, el contacto se
-- crea con el id opaco en `phone`, y ninguna dirección conocida es aceptable
-- por la API de envío. El bot genera la respuesta, Meta la rechaza, y el
-- mensaje se pierde en silencio.
--
-- Estas columnas guardan esa respuesta para poder reenviarla en el
-- momento en que un operador escriba el número real, en vez de tener que
-- pedirle al usuario que escriba otra vez.
--
-- Diseño:
--   * `awaiting_valid_phone` — el interruptor que la UI lee para mostrar
--     "Esperando número de teléfono válido". Es un booleano explícito y no
--     un "pending_reply_text IS NOT NULL" derivado, para que el aviso
--     pueda mostrarse aunque la respuesta pendiente se descarte después.
--   * `pending_reply_text`   — el texto exacto que el bot preparó, para
--     reenviarlo sin volver a llamar al LLM (que en este punto puede que
--     ya no exista, o ya haya dado una respuesta distinta a la guardada).
--   * `pending_reply_at`     — cuándo se generó, para que un operador
--     pueda descartar una respuesta vieja en lugar de mandarla horas
--     después.
-- ============================================================

-- Aviso para el operador. false por defecto: sólo se activa cuando un
-- envío fue rechazado de verdad por el destinatario.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS awaiting_valid_phone BOOLEAN NOT NULL DEFAULT FALSE;

-- Respuesta del bot pendiente de un destino válido.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS pending_reply_text TEXT;

-- Momento en que se generó la respuesta pendiente.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS pending_reply_at TIMESTAMPTZ;

-- La UI busca las conversaciones con aviso activo para mostrar el banner.
-- Índice parcial: sólo las que lo están, que son pocas.
CREATE INDEX IF NOT EXISTS idx_conversations_awaiting_valid_phone
  ON conversations (account_id, awaiting_valid_phone)
  WHERE awaiting_valid_phone = TRUE;

-- ============================================================
-- Saneado.
--
-- Una conversación no puede quedar con el aviso activo sin la respuesta
-- que lo justifica: eso sería un banner permanente sin nada que enviar.
-- Se apaga el aviso donde la respuesta ya falta, y se descarta la respuesta
-- huérfana donde ya no hay aviso, para que el próximo inbound la vuelva a
-- generar con un destino válido.
-- ============================================================
UPDATE conversations
   SET awaiting_valid_phone = FALSE
 WHERE awaiting_valid_phone = TRUE
   AND (pending_reply_text IS NULL OR pending_reply_text = '');

UPDATE conversations
   SET pending_reply_text = NULL,
       pending_reply_at = NULL
 WHERE pending_reply_text IS NOT NULL
   AND awaiting_valid_phone = FALSE;