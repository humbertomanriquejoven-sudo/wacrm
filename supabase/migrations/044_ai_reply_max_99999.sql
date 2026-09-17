-- ============================================================
-- 044_ai_reply_max_99999.sql — Fuerza el tope de auto-respuestas
--
-- El agente debe responder SIEMPRE mientras ningún humano esté asignado.
-- Por eso el valor guardado se fuerza a 99999 en TODAS las cuentas
-- existentes y como default para las nuevas, para que el panel muestre
-- siempre el máximo y ningún tope bajo (1-20) vuelva a dejarlo mudo.
-- El despacho en auto-reply.ts ya no compara ai_reply_count con ningún
-- máximo y pasa max_replies = 0 (ilimitado) al RPC de claim.
-- ============================================================

UPDATE ai_configs
SET auto_reply_max_per_conversation = 99999
WHERE auto_reply_max_per_conversation IS DISTINCT FROM 99999;

ALTER TABLE ai_configs
  ALTER COLUMN auto_reply_max_per_conversation SET DEFAULT 99999;