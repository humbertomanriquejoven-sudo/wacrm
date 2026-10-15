-- ============================================================
-- 076_ai_turn_dedupe.sql — Anti-duplicados del agente de IA
--
-- Objetivo: garantizar que UNA sola ejecución del auto-reply pueda
-- responder a un mensaje entrante concreto, incluso cuando el webhook
-- de Meta se entregue dos veces de forma CONCURRENTE (dos instancias
-- serverless a la vez, reintento del proveedor, etc.).
--
-- El dedupe existente aguas arriba (upsert idempotente sobre
-- messages(conversation_id, message_id) + el short-circuit de replay
-- en el webhook) protege cuando la segunda entrega llega DESPUÉS de
-- que la primera terminó de insertar. Este claim cubre la ventana que
-- ese mecanismo no cubre: dos despachos corriendo al MISMO tiempo
-- sobre el mismo wamid, donde ambos ven el mensaje como "nuevo".
--
-- Diseño:
--   * `ai_turn_claims` guarda (conversation_id, inbound_wamid) con un
--     índice único. El RPC `claim_ai_turn` hace un INSERT atómico con
--     ON CONFLICT DO NOTHING: exactamente un concurrente recibe true.
--     El perdedor se retira sin llamar al modelo ni enviar nada.
--   * La clave es por conversación Y por wamid: mensajes diferentes
--     del cliente (wamids distintos) reclaman turnos distintos y no se
--     bloquean entre sí — solo se bloquea el duplicado del MISMO evento.
--   * Seguro frente a concurrencia gracias al índice único de Postgres
--     (no a un read-then-write de la aplicación).
--
-- Idempotente: se puede reaplicar sin efectos acumulativos.
-- ============================================================

-- 1. Tabla de claims por turno (un evento entrante = un turno de IA).
CREATE TABLE IF NOT EXISTS public.ai_turn_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  inbound_wamid text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, inbound_wamid)
);

-- El claim es por conversación+wamid; este índice sirve además para el
-- mantenimiento/limpieza por antigüedad.
CREATE INDEX IF NOT EXISTS idx_ai_turn_claims_created_at
  ON public.ai_turn_claims (created_at);

-- 2. RPC atómico: devuelve true SOLO al primer concurrente.
CREATE OR REPLACE FUNCTION public.claim_ai_turn(
  p_conversation_id uuid,
  p_inbound_wamid text
)
RETURNS boolean AS $$
BEGIN
  INSERT INTO public.ai_turn_claims (conversation_id, inbound_wamid)
  VALUES (p_conversation_id, p_inbound_wamid)
  ON CONFLICT (conversation_id, inbound_wamid) DO NOTHING;
  -- FOUND es true solo si el INSERT insertó una fila; con
  -- ON CONFLICT DO NOTHING un duplicado no inserta y FOUND queda false.
  RETURN FOUND;
EXCEPTION
  -- Un claim que no puede persistirse NUNCA debe silenciar al bot
  -- (misma filosofía que claim_ai_reply_slot): se falla abierto y el
  -- despacho continúa. El dedupe de replay aguas arriba sigue activo.
  WHEN OTHERS THEN
    RAISE WARNING '[claim_ai_turn] claim no disponible para %: %',
      p_inbound_wamid, SQLERRM;
    RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- El despacho corre con el cliente service-role (webhook entrante sin
-- auth.uid()), así que necesita EXECUTE: sin este permiso el RPC falla
-- con permission-denied y el bot nunca responde (issue #345).
GRANT EXECUTE ON FUNCTION public.claim_ai_turn(uuid, text) TO service_role;

-- 3. Limpieza conservadora de claims viejos (> 30 días). Es solo
--    higiene: los wamids de Meta no se reutilizan, así que retenerlos
--    no afecta la corrección, solo el tamaño de la tabla.
DELETE FROM public.ai_turn_claims
WHERE created_at < now() - interval '30 days';
