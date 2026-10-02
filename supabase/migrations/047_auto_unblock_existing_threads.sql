-- ============================================================
-- 047_auto_unblock_existing_threads.sql
--
-- Libera TODOS los hilos que una sesión anterior dejó mudos.
--
-- Diagnóstico (síntoma reportado): el bot respondía bien a números
-- NUEVOS pero se callaba en conversaciones con historial previo
-- (p. ej. la de un contacto ya atendido).
--
-- La causa es estado ACUMULADO por conversación, que sólo existe en
-- hilos viejos:
--
--   * `assigned_agent_id` — lo escribe un nodo `handoff` de un Flow con
--     `assign_to` (flows/engine.ts) o un "Take over" manual, y nada lo
--     limpia después. Es LA bandera de pausa: este esquema NO tiene
--     columna `is_paused`.
--   * `status = 'pending'` — la misma ruta de handoff.
--   * `ai_autoreply_disabled` / `ai_reply_count` — columnas legacy de la
--     era con tope de respuestas.
--   * `flow_runs` en `status = 'active'` — una corrida stranded (el
--     cliente se quedó callado a mitad de un `collect_input`) hace que
--     `dispatchInboundToFlows` devuelva `consumed: true` para TODO
--     entrante posterior, así que la IA nunca recibe el turno. Sólo los
--     contactos que ya hablaron con un Flow pueden tener una.
--
-- Una conversación recién creada no tiene nada de eso — de ahí que los
-- números nuevos funcionaran y los hilos viejos no.
--
-- Idempotente: se puede reaplicar sin efectos acumulativos.
-- ============================================================

-- ============================================================
-- 1. Hilos: limpiar TODA señal de silenciamiento.
-- ============================================================
DO $$
DECLARE
  cleared integer;
  paused_reset integer;
  counters_reset integer;
  reopened integer;
BEGIN
  -- 1a. Asignación de agente (la pausa real).
  UPDATE conversations
     SET assigned_agent_id = NULL
   WHERE assigned_agent_id IS NOT NULL;
  GET DIAGNOSTICS cleared = ROW_COUNT;
  RAISE NOTICE '[047] conversaciones con assigned_agent_id liberado: %', cleared;

  -- 1b. Volver a 'open' los hilos en 'pending' por un handoff. 'closed'
  --     NO se toca: un cierre explícito de un agente es una decisión, y
  --     `reopenClosedConversation` ya lo revierte al llegar un entrante.
  UPDATE conversations
     SET status = 'open'
   WHERE status = 'pending';
  GET DIAGNOSTICS reopened = ROW_COUNT;
  RAISE NOTICE '[047] conversaciones reabiertas desde status=pending: %', reopened;

  -- 1c. Banderas y contadores legacy. Guardados por información de
  --     esquema para que la migración corra también en bases sin la 029.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'conversations'
       AND column_name = 'ai_autoreply_disabled'
  ) THEN
    UPDATE conversations SET ai_autoreply_disabled = false
     WHERE ai_autoreply_disabled;
    GET DIAGNOSTICS paused_reset = ROW_COUNT;
    RAISE NOTICE '[047] ai_autoreply_disabled limpiado en: %', paused_reset;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'conversations'
       AND column_name = 'ai_reply_count'
  ) THEN
    UPDATE conversations SET ai_reply_count = 0
     WHERE ai_reply_count <> 0;
    GET DIAGNOSTICS counters_reset = ROW_COUNT;
    RAISE NOTICE '[047] ai_reply_count reiniciado en: %', counters_reset;
  END IF;

  -- 1d. Flags de pausa heredados que podrían existir en instalaciones
  --     antiguas (este esquema no los tiene).
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'conversations'
       AND column_name = 'is_paused'
  ) THEN
    UPDATE conversations SET is_paused = false WHERE is_paused IS DISTINCT FROM false;
    RAISE NOTICE '[047] columna legacy is_paused limpiada';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'conversations'
       AND column_name = 'auto_reply_count'
  ) THEN
    UPDATE conversations SET auto_reply_count = 0 WHERE auto_reply_count <> 0;
    RAISE NOTICE '[047] columna legacy auto_reply_count reiniciada';
  END IF;
END $$;

-- ============================================================
-- 2. Corridas de Flow stranded.
--
-- Mientras exista una fila `flow_runs` en 'active' para el contacto,
-- el runner consume CADA entrante posterior y la IA nunca entra. Se
-- marcan 'timed_out' (estado terminal ya soportado por el CHECK de
-- flow_runs.status) en vez de borrarse, para conservar el historial.
--
-- 'paused_by_agent' se barre también: es el equivalente en Flows de la
-- pausa manual, y un hilo en ese estado es otro modo del mismo
-- síntoma (el flujo se quedó esperando después de que un agente
-- respondiera).
-- ============================================================
DO $$
DECLARE
  runs_closed integer;
  runs_paused integer;
BEGIN
  IF to_regclass('public.flow_runs') IS NOT NULL THEN
    UPDATE flow_runs
       SET status = 'timed_out'
     WHERE status = 'active';
    GET DIAGNOSTICS runs_closed = ROW_COUNT;
    RAISE NOTICE '[047] corridas de Flow active -> timed_out: %', runs_closed;

    UPDATE flow_runs
       SET status = 'timed_out'
     WHERE status = 'paused_by_agent';
    GET DIAGNOSTICS runs_paused = ROW_COUNT;
    RAISE NOTICE '[047] corridas de Flow paused_by_agent -> timed_out: %', runs_paused;
  ELSE
    RAISE NOTICE '[047] flow_runs no existe; se omite la limpieza de corridas';
  END IF;
END $$;

-- ============================================================
-- 3. contacts
--
-- En este esquema `contacts` NO tiene ninguna bandera de pausa ni de
-- bloqueo (sólo phone, name, email, company, avatar_url). Se limpia
-- cualquier columna de bloqueo que exista en instalaciones antiguas,
-- y se normaliza el teléfono para que el lookup del webhook no falle
-- por formato y termine creando un contacto duplicado (que abre un
-- hilo NUEVO y deja el viejo mudo — otro modo del mismo síntoma).
-- ============================================================
DO $$
DECLARE
  deduped integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'contacts'
       AND column_name = 'is_blocked'
  ) THEN
    UPDATE contacts SET is_blocked = false WHERE is_blocked;
    RAISE NOTICE '[047] columna legacy contacts.is_blocked limpiada';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'contacts'
       AND column_name = 'is_paused'
  ) THEN
    UPDATE contacts SET is_paused = false WHERE is_paused IS DISTINCT FROM false;
    RAISE NOTICE '[047] columna legacy contacts.is_paused limpiada';
  END IF;

  -- Normaliza a sólo dígitos. `normalizePhone()` en el webhook hace lo
  -- mismo, pero dejar la BD desalineada hacía que un contacto guardado
  -- como '3001234567' no casara con el entrante '573001234567' y el
  -- webhook creara un contacto (y un hilo) nuevo para el mismo número.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'contacts'
       AND column_name = 'phone'
  ) THEN
    UPDATE contacts
       SET phone = regexp_replace(phone, '[^0-9]', '', 'g')
     WHERE phone ~ '[^0-9]';
    GET DIAGNOSTICS deduped = ROW_COUNT;
    RAISE NOTICE '[047] teléfonos de contacto normalizados a dígitos: %', deduped;
  END IF;
END $$;

-- ============================================================
-- 4. claim_ai_reply_slot sin tope real (refuerza 046).
--
-- Sin esto, una base con la función de la 029 evaluate
-- `ai_reply_count < max_replies` y rechace el slot, dejando el bot
-- mudo aunque todo lo demás esté bien.
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

GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid, integer) TO service_role;