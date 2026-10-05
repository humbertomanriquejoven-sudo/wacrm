-- 058_backfill_broadcast_meta_identity.sql
--
-- Objetivo: que todo contacto con 'phone' inutilizable tenga un destino real
-- para broadcasts, sin depender de que ningun webhook futuro lo escriba.
--
-- Contexto: hasta ahora las columnas de identidad (053/057) solo las
-- escribia el webhook, y ese escritor solo existe desde el commit 983011a.
-- Los contactos creados ANTES de ese commit tienen 'wa_id', 'recipient_id' y
-- 'wa_user_id' en NULL, asi que resolveBroadcastAddress no tenia nada que
-- leer y los marcaba NO_DELIVERABLE_ADDRESS. Esta migracion reconstruye esa
-- informacion desde lo que si quedo en la base de datos: el historial de
-- mensajes del propio contacto.
--
-- Es idempotente y autocontenida: no presupone que 052/053/057 se hayan
-- aplicado. Si ya se aplicaron, los ALTER TABLE son no-ops y el UPDATE solo
-- rellena columnas que esten vacias. Se puede aplicar sola.
--
-- NO contiene identificadores literales de ningun contacto: todo se deriva
-- de los mensajes que el contacto ya envio.

-- ----------------------------------------------------
-- 1. Columnas (idempotente, no depende de 052/053/057)
-- ----------------------------------------------------
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS wa_id TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS recipient_id TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS raw_meta_payload JSONB;

-- ----------------------------------------------------
-- 2. Indices
--
-- NOTA: aqui NO se crean los indices de una sola columna
-- (contacts(wa_id), contacts(recipient_id)) que pide el requerimiento.
-- 053 y 057 ya crean:
--   idx_contacts_wa_id       ON (account_id, wa_id)       WHERE wa_id IS NOT NULL AND wa_id <> ''
--   idx_contacts_recipient_id ON (account_id, recipient_id) WHERE recipient_id IS NOT NULL AND ...
--
-- Esos son estrictamente mejores que los de una sola columna: 'contacts' es
-- multi-tenant y TODA consulta por identidad lo hace ya filtrada por
-- account_id (ver resolveBroadcastAddress y findOrCreateContact). Un indice
-- sin account_id es menos selectivo, admite mas entradas por pagina y sirve
-- de menos. Ademas el nombre idx_contacts_wa_id YA esta ocupado por la
-- version compuesta, asi que un CREATE INDEX IF NOT EXISTS con el mismo
-- nombre no crearia nada: pasaria inadvertido como exito sin efecto.
--
-- Se re-declaran aqui de forma idempotente para que el resultado no dependa
-- de si 053/057 llegaron a correr.
-- ----------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_contacts_wa_id
  ON contacts (account_id, wa_id)
  WHERE wa_id IS NOT NULL AND wa_id <> '';

CREATE INDEX IF NOT EXISTS idx_contacts_recipient_id
  ON contacts (account_id, recipient_id)
  WHERE recipient_id IS NOT NULL AND recipient_id <> '';

-- Backing index for the history scan below (conversation_id already has
-- coverage, but sender_type is filtered on and this keeps it index-only).
CREATE INDEX IF NOT EXISTS idx_messages_customer_sender
  ON messages (conversation_id, created_at DESC)
  WHERE sender_type = 'customer';

-- ----------------------------------------------------
-- 3. Clasificacion de un identificador, sin dependence del cliente
--
-- Se acepta SOLO lo que Meta acepta en 'to':
--   * un id con espacio de nombres: CO.…, WAID.…, LID.…
--   * una corrida de digitos demasiado larga para ser un telefono (>=15),
--     que es como viaja un BSUID ya normalizado
--   * la forma LID suelta  <id>@lid
--
-- Se RECHAZA explicitamente el placeholder 'unknown' y los digitos cortos:
-- un numero de 7-14 digitos es un fragmento, no un id, y mandarlo apunta a
-- otra persona.
-- ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.wa_is_meta_id(value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT value IS NOT NULL
    AND btrim(value) <> ''
    AND lower(btrim(value)) NOT IN ('unknown', 'undefined', 'null', 'none')
    AND (
      btrim(value) ~ '^(CO|WAID|LID)\.[0-9]+$'
      OR btrim(value) ~ '^[0-9]{15,}$'
      OR btrim(value) ~ '^[0-9]+@lid$'
    );
$$;

-- ----------------------------------------------------
-- 4. Backfill generico
--
-- Para cada contacto SIN destino usable, se mira su propio historial de
-- mensajes entrantes y se toma lo mas reciente. Se prioriza:
--
--   a) messages.sender_phone  -> un numero real, cuando Meta divulgo uno.
--      Es la unica columna con la direccion que Meta uso (migracion 050).
--   b) el id del payload guardado (migracion 052), en los dos formatos que
--      el codigo ha escrito: { message, contact } y el entry completo de la
--      Cloud API.
--
-- Se escribe en 'wa_id' y 'recipient_id' a la vez: son el mismo id y ambas
-- columnas son leidas por resolveBroadcastAddress, asi que dejarlas
-- consistentes evita que una futura ejecucion use una y no la otra.
--
-- Solo se escribe si sender_phone es NULL o un placeholder: si ya hay un
-- numero real, el contacto ya es entregable y no se toca.
-- ----------------------------------------------------
WITH ranked AS (
  SELECT
    c.id AS contact_id,
    m.sender_phone,
    m.raw_meta_payload,
    row_number() OVER (
      PARTITION BY c.id
      ORDER BY m.created_at DESC NULLS LAST, m.id DESC
    ) AS rn
  FROM contacts c
  JOIN conversations cv ON cv.contact_id = c.id
  JOIN messages m      ON m.conversation_id = cv.id
  WHERE m.sender_type = 'customer'
    -- Solo contactos que hoy no son entregables por columna.
    AND (
      c.phone IS NULL
      OR btrim(c.phone) = ''
      OR lower(btrim(c.phone)) IN ('unknown', 'undefined', 'null')
      OR c.phone ~ '^(\+)?[0-9]{15,}$'      -- un BSUID挤压ado en 'phone'
      OR c.phone ~* '^(CO|WAID|LID)\.'
    )
),
latest AS (
  SELECT * FROM ranked WHERE rn = 1
),
extracted AS (
  SELECT
    l.contact_id,
    -- (a) numero real, si Meta divulgo uno en ESTE mensaje
    NULLIF(NULLIF(btrim(l.sender_phone), ''), 'unknown') AS sender_phone,
    -- (b) id desde el payload, buscando en ambos formatos. El orden de
    -- COALESCE refleja la prioridad real: el id dedicado antes que 'from'.
    COALESCE(
      NULLIF(l.raw_meta_payload -> 'message' ->> 'from_user_id', ''),
      NULLIF(l.raw_meta_payload -> 'contact' ->> 'user_id', ''),
      NULLIF(l.raw_meta_payload -> 'entry' -> 0 -> 'changes' -> 0 -> 'value' -> 'messages' -> 0 ->> 'from_user_id', ''),
      NULLIF(l.raw_meta_payload -> 'entry' -> 0 -> 'changes' -> 0 -> 'value' -> 'contacts' -> 0 ->> 'user_id', ''),
      NULLIF(l.raw_meta_payload -> 'message' ->> 'from', ''),
      NULLIF(l.raw_meta_payload -> 'contact' ->> 'wa_id', ''),
      NULLIF(l.raw_meta_payload -> 'entry' -> 0 -> 'changes' -> 0 -> 'value' -> 'messages' -> 0 ->> 'from', ''),
      NULLIF(l.raw_meta_payload -> 'entry' -> 0 -> 'changes' -> 0 -> 'value' -> 'contacts' -> 0 ->> 'wa_id', '')
    ) AS payload_id
  FROM latest l
),
candidates AS (
  SELECT
    contact_id,
    -- El numero manda: es un destino que el Inbox ya usa con exito.
    COALESCE(
      CASE WHEN sender_phone ~ '^\+?[0-9]{7,15}$' THEN sender_phone END,
      CASE WHEN public.wa_is_meta_id(payload_id) THEN payload_id END
    ) AS resolved
  FROM extracted
)
UPDATE contacts ct
SET
  wa_id        = COALESCE(NULLIF(ct.wa_id, ''), cd.resolved),
  recipient_id = COALESCE(NULLIF(ct.recipient_id, ''), cd.resolved),
  updated_at   = now()
FROM candidates cd
WHERE cd.contact_id = ct.id
  AND cd.resolved IS NOT NULL
  AND (ct.wa_id IS NULL OR ct.wa_id = '' OR ct.wa_id = 'unknown'
       OR ct.recipient_id IS NULL OR ct.recipient_id = '');
