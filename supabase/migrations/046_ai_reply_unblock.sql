-- ============================================================
-- 046_ai_reply_unblock.sql — Desbloquea los hilos que el bot dejó mudos
--
-- Objetivo: que el agente de IA vuelva a responder SIEMPRE a cada
-- mensaje entrante mientras ningún humano esté a cargo del hilo, sin
-- que un contador heredado ni un "Take over" antiguo lo dejen bloqueado
-- de forma permanente.
--
-- Diagnóstico: la única condición que silencia al bot en el código es
-- `conversations.assigned_agent_id IS NOT NULL` (el "Take over"). El
-- tope por contador ya no se aplicaba en el despacho, pero el estado
-- acumulado en la base de datos sí quedó ahí:
--
--   * `ai_reply_count` seguía creciendo y muchas conversaciones ya
--     habían alcanzado el tope antiguo (1-20 de la migración 029). Con
--     el RPC de esa versión (`ai_reply_count < max_replies`) cualquier
--     valor de max_replies enviado como 0 dejaba el hilo mudo para
--     siempre, porque el dispatch aborta antes de enviar.
--   * `ai_autoreply_disabled` quedó en `true` en hilos donde una versión
--     anterior hizo handoff automático.
--   * `assigned_agent_id` seguía poblado en hilos tomados a mano, que
--     es la condición que hoy detiene el despacho.
--
-- Idempotente: se puede reaplicar sin efectos acumulativos.
-- ============================================================

-- ============================================================
-- 1. claim_ai_reply_slot:.sin tope real, nunca rechaza el slot.
--
-- Se conserva el UPDATE único (el candado de fila de Postgres más el
-- re-chequeo READ COMMITTED serializan dos despachos concurrentes sobre
-- el mismo hilo, así que el rol de concurrencia se mantiene intacto),
-- pero ahora 0, NULL, negativo o >= 99999 significan "ilimitado".
-- Antes, un 0 caía en `ai_reply_count < 0` -> siempre falso -> el bot
-- nunca enviaba nada. Ver issue #345 y migraciones 029 / 041.
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_ai_reply_slot(
  conversation_id uuid,
  max_replies integer
)
RETURNS boolean AS $$
  WITH claimed AS (
    UPDATE conversations
    SET ai_reply_count = ai_reply_count + 1
    WHERE id = conversation_id
      AND (
        max_replies IS NULL
        OR max_replies <= 0
        OR max_replies >= 99999
        OR ai_reply_count < max_replies
      )
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

-- El despacho corre con el cliente service-role (el webhook entrante no
-- tiene auth.uid()), así que necesita EXECUTE: sin este permiso el RPC
-- falla con permission-denied y el bot nunca responde.
GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid, integer) TO service_role;

-- ============================================================
-- 2. Reinicia contadores y flags legacy en TODAS las conversaciones.
-- ============================================================
DO $$
DECLARE
  reset_count integer;
BEGIN
  UPDATE conversations
  SET ai_reply_count = 0,
      ai_autoreply_disabled = false
  WHERE ai_reply_count <> 0
     OR ai_autoreply_disabled;
  GET DIAGNOSTICS reset_count = ROW_COUNT;
  RAISE NOTICE '[046] conversaciones con contador/flag reiniciado: %', reset_count;
END $$;

-- ============================================================
-- 3. Libera las asignaciones: el "Take over" es lo único que detiene
--    al bot, así que vaciar assigned_agent_id devuelve todos los hilos
--    al agente de IA. Esto borra el reparto de trabajo de los agentes
--    humanos, que es justo lo pedido.
-- ============================================================
DO $$
DECLARE
  released_count integer;
BEGIN
  UPDATE conversations
  SET assigned_agent_id = NULL
  WHERE assigned_agent_id IS NOT NULL;
  GET DIAGNOSTICS released_count = ROW_COUNT;
  RAISE NOTICE '[046] asignaciones liberadas (asignadas al bot): %', released_count;
END $$;

-- ============================================================
-- 4. Columnas de pausa que pueden existir en instalaciones antiguas
--    (este esquema no las tiene: la pausa es assigned_agent_id). Se
--    limpian sólo si están presentes, para que la migración corra en
--    cualquier base sin fallar.
-- ============================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'conversations'
      AND column_name = 'is_paused'
  ) THEN
    EXECUTE 'UPDATE conversations SET is_paused = false WHERE is_paused IS DISTINCT FROM false';
    RAISE NOTICE '[046] columna legacy is_paused limpiada';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'conversations'
      AND column_name = 'auto_reply_count'
  ) THEN
    EXECUTE 'UPDATE conversations SET auto_reply_count = 0 WHERE auto_reply_count <> 0';
    RAISE NOTICE '[046] columna legacy auto_reply_count reiniciada';
  END IF;
END $$;

-- ============================================================
-- 5. Tope por defecto 99999 en la configuración (refuerza 044).
-- ============================================================
UPDATE ai_configs
SET auto_reply_max_per_conversation = 99999
WHERE auto_reply_max_per_conversation IS DISTINCT FROM 99999;

ALTER TABLE ai_configs
  ALTER COLUMN auto_reply_max_per_conversation SET DEFAULT 99999;