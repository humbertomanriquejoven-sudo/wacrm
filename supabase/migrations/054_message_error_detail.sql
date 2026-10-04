-- ============================================================
-- 054_message_error_detail.sql
--
-- Cuando Meta rechaza un envío, `sendTextMessage` lanza y el flujo
-- abortaba ANTES del INSERT en `messages`. El resultado era que un
-- rechazo de Meta no dejaba ni una fila: nada en el hilo, nada que
-- consultar, y la única evidencia era una línea de consola que se
-- desplaza. Diagnosticar en producción ("¿por qué la IA no respondió?")
-- era imposible.
--
-- Esta columna guarda el motivo textual del fallo junto a la fila del
-- mensaje, de modo que un rechazo queda:
--   * visible en el hilo del Inbox como mensaje `status='failed'`;
--   * consultable con un simple SELECT para depurar en EasyPanel;
--   * reintentable por un proceso posterior, porque la fila ya existe.
--
-- `status='failed'` ya está permitido por el CHECK de la migración 001
-- ('sending','sent','delivered','read','failed'), así que no hace falta
-- tocar la restricción: sólo se añade el detalle del error.
--
-- Es texto libre a propósito: el cuerpo del error de Meta cambia entre
-- versiones de la API y entre locales, y es justamente ese texto el que
-- hace falta para identificar la causa. Se escribe sólo en fallo y nunca
-- se reescribe.
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS error_detail TEXT;

COMMENT ON COLUMN messages.error_detail IS
  'Motivo textual del rechazo de Meta cuando status=''failed''. Incluye el destino intentado (to). Sólo se escribe en fallo.';

-- Índice parcial: sólo las filas fallidas se consultan al depurar, y son
-- una fracción minúscula de la tabla. Acelera tanto el "ver todos los
-- fallos" como el barrido de reintentos sin penalizar las consultas
-- normales por estado.
CREATE INDEX IF NOT EXISTS idx_messages_failed
  ON messages (conversation_id, created_at DESC)
  WHERE status = 'failed';