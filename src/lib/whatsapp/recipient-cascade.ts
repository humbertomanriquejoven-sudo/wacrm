// ============================================================
// Waterfall destination resolution (CASCADE) with diagnostic report.
//
// Every outbound send needs the same answer: "what goes in Meta's `to`?"
// This module answers it by inspecting the database — with the service
// role key (`supabaseAdmin`, RLS bypass) — across five sources in STRICT
// priority order:
//
//   Fuente 1: contacts.phone
//   Fuente 2: contacts.metadata ->> phone  |  contacts.metadata ->> wa_id
//   Fuente 3: conversations.wa_id  |  conversations.metadata ->> phone
//   Fuente 4: ID del canal / BSUID numérico guardado en la conversación
//   Fuente 5: último mensaje entrante (messages direction = inbound):
//             sender_id / raw_payload ->> message ->> from
//
// REGLA DE SANITIZACIÓN (for every source): the string is cleaned down to
// NUMERIC DIGITS ONLY ('+', '-', '@', spaces and letters are dropped). A
// source whose cleaned value is NOT a pure digit run of >= 8 digits is
// marked INVALIDO. The FIRST source that yields a valid digit run wins.
//
// A `[INFORME_DIAGNOSTICO_DESTINATARIO]` block is printed to the console
// BEFORE any Meta Graph API call, and the shape is carried on the 422 the
// callers surface when no source resolves, plus the `how_to_fix` guidance.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { metaIdFromRawPayload } from '@/lib/whatsapp/broadcast-address'
import { isPlaceholderValue } from '@/lib/whatsapp/phone-utils'

/**
 * The operator-facing fix for "no valid destination". Exposed so the send
 * core and the HTTP layers all quote the exact same copy.
 */
export const HOW_TO_FIX_DESTINATION =
  'CÓMO SOLUCIONARLO: 1. Escribe el número telefónico del cliente con código de país en el panel derecho (ej. 573001234567). 2. Presiona Guardar. Si el cliente escribe un nuevo mensaje, el sistema vinculará su canal automáticamente.'

export type CascadeSourceKey =
  | 'contacts_phone'
  | 'contacts_metadata'
  | 'conversations_wa_id'
  | 'channel_bsuid'
  | 'latest_inbound_from'

export interface CascadeSourceStatus {
  /** The raw value found for the source ('' when absent). */
  raw: string
  /** 'VALIDO' when the cleaned value is a pure numeric run of >= 8 digits. */
  status: 'VALIDO' | 'INVALIDO'
  /** The digits-only form; '' when INVALIDO. */
  digits: string
}

export interface DestinationCascadeReport {
  conversationId: string | null
  contactId: string | null
  sources: Record<CascadeSourceKey, CascadeSourceStatus>
  /** The first source's digit run, or null when no source was valid. */
  finalTo: string | null
  chosen: CascadeSourceKey | null
  /** Raw contact phone as stored in the DB ('' when absent). */
  phoneDb: string
  /** Raw conversation-level id (wa_id / channel_id) — '' when absent. */
  bsuid: string
  /** True when the conversation-level id yields a VALID numeric run. */
  bsuidValid: boolean
  /** Newest inbound wamid in this conversation, or null when there is none. */
  latestInboundWamid: string | null
}

const SEPARATOR = '='.repeat(50)

/**
 * Sanitize a source value per the REGLA DE SANITIZACIÓN: keep ONLY numeric
 * digits (drop '+', '-', '@', spaces and letters); a pure digit run of
 * 8+ digits is VALIDO, anything else is INVALIDO. A placeholder tale
 * ('unknown', 'null', 'n/a') is treated as absent.
 */
export function sanitizeCascadeSource(raw: unknown): CascadeSourceStatus {
  const valueForReport = raw == null ? '' : String(raw)
  const trimmed = String(raw ?? '').trim()
  const digits = trimmed.replace(/\D/g, '')
  const valid = digits.length >= 8 && !isPlaceholderValue(trimmed)
  return {
    raw: valueForReport,
    status: valid ? 'VALIDO' : 'INVALIDO',
    digits: valid ? digits : '',
  }
}

/** The flat `diagnostic_report` object carried on the HTTP 422 (and logs). */
export function toDiagnosticHttp(
  report: DestinationCascadeReport,
): Record<string, string> {
  return {
    // Definitive CRM-facing keys (Task 3B): the UI reads these three.
    phone_db: report.phoneDb,
    bsuid: report.bsuid,
    selected_target: report.finalTo ?? '',
    // Granular per-source detail, kept for deeper debugging.
    contacts_phone: report.sources.contacts_phone.raw ?? '',
    contacts_metadata: report.sources.contacts_metadata.raw ?? '',
    conversations_wa_id: report.sources.conversations_wa_id.raw ?? '',
    channel_bsuid: report.sources.channel_bsuid.raw ?? '',
    latest_inbound_from: report.sources.latest_inbound_from.raw ?? '',
  }
}

/** The console block printed (A) before every Meta Graph API call. */
export function formatDestinationCascadeReport(
  report: DestinationCascadeReport,
): string {
  return [
    SEPARATOR,
    '[INFORME_DIAGNOSTICO_DESTINATARIO]',
    `- Conversation ID: ${report.conversationId ?? ''}`,
    `- Contact ID: ${report.contactId ?? ''}`,
    `- Contact Phone (DB): "${report.phoneDb}" -> [${report.sources.contacts_phone.status}]`,
    `- Conversation BSUID/WA_ID: "${report.bsuid}" -> [${report.bsuidValid ? 'VALIDO' : 'INVALIDO'}]`,
    `- Last Inbound WAMID: "${report.latestInboundWamid ?? 'NINGUNO'}"`,
    `- DESTINATARIO FINAL SELECCIONADO: "${report.finalTo ?? 'NINGUNO'}"`,
    SEPARATOR,
  ].join('\n')
}

export function printDestinationCascadeReport(
  report: DestinationCascadeReport,
): void {
  console.log(formatDestinationCascadeReport(report))
}

export interface CascadeBuildArgs {
  conversationId: string | null | undefined
  contactId: string | null | undefined
  accountId: string
  /**
   * The contact row as currently known (service-role override applied). Its
   * `phone`, `wa_id`, `wa_user_id`, `recipient_id` and `metadata` feed
   * Fuentes 1, 2 and 4; the conversation embed supplies Fuentes 3 and 4.
   */
  contact?: {
    phone?: unknown
    wa_id?: unknown
    wa_user_id?: unknown
    recipient_id?: unknown
    metadata?: unknown
  } | null
  /** The conversation row already loaded (embed) — fallback for Fuentes 3/4. */
  conversation?: Record<string, unknown> | null
  /** Query seam — the send core always uses the service-role client. */
  db?: Pick<SupabaseClient, 'from'>
}

/**
 * Run the five-source waterfall and return the report. Every service-role
 * read is defensive: a missing column, an RLS-blocked client or an
 * unconfigured deployment degrades that source to the already-loaded embed
 * (or to INVALIDO) and never takes the send down.
 */
export async function buildDestinationCascadeReport(
  args: CascadeBuildArgs,
): Promise<DestinationCascadeReport> {
  const { conversationId, contactId, accountId, contact, conversation } = args
  const db = args.db ?? supabaseAdmin()

  // Fuente 1 — contacts.phone (the strict service-role override already ran).
  const contactsPhone = sanitizeCascadeSource(contact?.phone)

  // Fuente 2 — contacts.metadata ->> phone | contacts.metadata ->> wa_id.
  const meta =
    contact?.metadata && typeof contact.metadata === 'object'
      ? (contact.metadata as Record<string, unknown>)
      : null
  const contactsMetadata = sanitizeCascadeSource(meta?.phone ?? meta?.wa_id)

  // Fuente 3 — conversations.wa_id | conversations.metadata ->> phone/wa_id.
  // Best-effort service-role read; the embed is the fallback.
  let convo: Record<string, unknown> | null = conversation ?? null
  try {
    const { data, error } = await db
      .from('conversations')
      .select('wa_id, channel_id, metadata')
      .eq('id', conversationId ?? '')
      .eq('account_id', accountId)
      .maybeSingle()
    if (!error && data && typeof data === 'object') {
      convo = data as Record<string, unknown>
    }
  } catch {
    // Columnas ausentes o cliente indisponible — se usa el embed.
  }
  const convoMeta =
    convo?.metadata && typeof convo.metadata === 'object'
      ? (convo.metadata as Record<string, unknown>)
      : null
  const conversationsWaId = sanitizeCascadeSource(
    convo?.wa_id ?? convoMeta?.phone ?? convoMeta?.wa_id
  )

  // Fuente 4 — ID del canal / BSUID numérico guardado en la conversación:
  // conversation.channel_id, o el BSUID del contacto vinculado a la conversación.
  const channelBsuid = sanitizeCascadeSource(
    convo?.channel_id ??
      contact?.wa_id ??
      contact?.wa_user_id ??
      contact?.recipient_id
  )

  // Fuente 5 — último mensaje entrante: sender_id / raw_payload ->> from,
  // y su wamid (para anclar el envío a un BSUID cuando se necesita).
  // Leída siempre con la service role: un cliente con RLS (user-scoped) jamás
  // debe secuestrar la resolución del destinatario.
  let latestInboundFrom: CascadeSourceStatus = sanitizeCascadeSource(null)
  let latestInboundWamid: string | null = null
  if (conversationId) {
    try {
      const { data, error } = await db
        .from('messages')
        .select('sender_phone, raw_meta_payload, message_id')
        .eq('conversation_id', conversationId)
        .eq('sender_type', 'customer')
        .order('created_at', { ascending: false })
        .limit(1)
      const row = (data ?? [])[0] as
        | {
            sender_phone?: string | null
            raw_meta_payload?: unknown
            message_id?: string | null
          }
        | undefined
      if (!error && row) {
        latestInboundFrom = sanitizeCascadeSource(
          row.sender_phone ?? metaIdFromRawPayload(row.raw_meta_payload)
        )
        if (typeof row.message_id === 'string' && row.message_id) {
          latestInboundWamid = row.message_id
        }
      }
    } catch {
      // best-effort por diseño: sin huella no se inventa destino.
      latestInboundFrom = sanitizeCascadeSource(null)
    }
  }

  const sources: Record<CascadeSourceKey, CascadeSourceStatus> = {
    contacts_phone: contactsPhone,
    contacts_metadata: contactsMetadata,
    conversations_wa_id: conversationsWaId,
    channel_bsuid: channelBsuid,
    latest_inbound_from: latestInboundFrom,
  }

  // Select the FIRST source that returns a purely numeric run of >= 8 digits.
  let finalTo: string | null = null
  let chosen: CascadeSourceKey | null = null
  for (const key of Object.keys(sources) as CascadeSourceKey[]) {
    if (sources[key].status === 'VALIDO') {
      finalTo = sources[key].digits
      chosen = key
      break
    }
  }

  // The conversation-level id the log/HTTP report presents as "BSUID/WA_ID":
  // the wamid stored on the conversation (S3) when available, else the channel
  // id (S4). Marked VALIDO when either of those sources is.
  const bsuid =
    sources.conversations_wa_id.raw !== ''
      ? sources.conversations_wa_id.raw
      : sources.channel_bsuid.raw
  const bsuidValid =
    sources.conversations_wa_id.status === 'VALIDO' ||
    sources.channel_bsuid.status === 'VALIDO'

  return {
    conversationId: conversationId ?? null,
    contactId: contactId ?? null,
    sources,
    finalTo,
    chosen,
    phoneDb: sources.contacts_phone.raw ?? '',
    bsuid,
    bsuidValid,
    latestInboundWamid,
  }
}