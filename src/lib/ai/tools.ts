import type { SupabaseClient } from '@supabase/supabase-js'
import type { ToolDefinition, ToolCall } from './types'
import {
  agendar_cita,
  cancelar_cita,
  listar_eventos,
  reagendar_cita,
  ver_disponibilidad,
} from '@/lib/calendar'
import { enviar_correo, leer_correos, gmailConfigured } from '@/lib/gmail'

// ============================================================
// Tool definitions and handlers for the AI auto-reply agent.
// ============================================================

/**
 * Tool that lets the AI update client profile data extracted from
 * the conversation. Invoked automatically when the model detects
 * the customer sharing personal or project information.
 */
export const UPDATE_CLIENT_PROFILE_TOOL: ToolDefinition = {
  name: 'update_client_profile',
  description:
    'Save or update the client profile when the customer shares personal information during the conversation. ' +
    'Invoke this whenever the customer mentions their name, email, location (city/neighborhood), type of project, or budget. ' +
    'You may call this tool multiple times as new information becomes available.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Full name of the customer (e.g. "Carlos Pérez")',
      },
      email: {
        type: 'string',
        description: 'Email address of the customer',
      },
      location: {
        type: 'string',
        description:
          'City, neighborhood, or address of the customer (e.g. "Bogotá", "Chía", "Cajicá")',
      },
      project_type: {
        type: 'string',
        description:
          'Type of project or service the customer is interested in (e.g. "remodelación", "diseño interior", "renders 3D")',
      },
      budget: {
        type: 'string',
        description:
          'Budget or price range mentioned by the customer (e.g. "15 millones", "5-8 millones COP")',
      },
    },
  },
}

/** Google Calendar — list free 45-minute slots within business hours. */
export const VER_DISPONIBILIDAD_TOOL: ToolDefinition = {
  name: 'ver_disponibilidad',
  description:
    'List available appointment slots in the business calendar. ' +
    'Call this BEFORE agendar_cita or reagendar_cita to confirm the customer\'s requested date/time. ' +
    'Business hours: Monday to Sunday 08:00-23:00 (America/Bogota, UTC-5). ' +
    'Pass the date range the customer is asking about.',
  parameters: {
    type: 'object',
    properties: {
      desde: {
        type: 'string',
        description:
          'Start of the window to check, ISO date or date-time in Bogota time (e.g. "2026-05-04" or "2026-05-04T09:00:00-05:00")',
      },
      hasta: {
        type: 'string',
        description:
          'End of the window to check, ISO date or date-time in Bogota time (e.g. "2026-05-08")',
      },
    },
    required: ['desde', 'hasta'],
  },
}

/** Google Calendar — book a 45-minute appointment and link it to the contact. */
export const AGENDAR_CITA_TOOL: ToolDefinition = {
  name: 'agendar_cita',
  description:
    'Schedule a 45-minute appointment for the customer in the business calendar. ' +
    'CALL IT IMMEDIATELY when the customer states a concrete date/time — do not ask again for the date/time or the reason. ' +
    'motivo is optional and defaults to "Consulta / Valoración" when omitted. ' +
    'Google creates a Meet link (or returns the calendar event URL as fallback) and emails the customer an invitation. ' +
    'Pass the customer email when you know it, so they receive the invite with the link. ' +
    'On success the tool returns confirmado:true plus the exact link (hangoutLink or htmlLink; meet.google.com/new as last fallback) to share with the customer. ' +
    'The confirmation WhatsApp message to the customer MUST ALWAYS include the Google Meet URL — never send a booking confirmation without it.',
  parameters: {
    type: 'object',
    properties: {
      inicio: {
        type: 'string',
        description:
          'Start date-time of the appointment in ISO 8601 with the Bogota offset, e.g. "2026-05-04T10:00:00-05:00"',
      },
      nombre: {
        type: 'string',
        description: 'Customer name to put on the calendar event',
      },
      motivo: {
        type: 'string',
        description:
          'Reason or topic of the appointment (e.g. "cotización de interiores"). Optional: defaults to "Consulta / Valoración", so never block the booking by asking for it.',
      },
      email: {
        type: 'string',
        description:
          'Customer email, used to send the Google Calendar invitation with the Meet link (optional — never block the booking if you do not have it)',
      },
    },
    required: ['inicio', 'nombre'],
  },
}

/** Google Calendar — move an existing appointment to another slot. */
export const REAGENDAR_CITA_TOOL: ToolDefinition = {
  name: 'reagendar_cita',
  description:
    'Reschedule an existing appointment to a new start time. ' +
    'Call ver_disponibilidad first to find a free slot; the appointment\'s own ' +
    'current slot is excluded from availability checks, so moving it back to its ' +
    'current time is allowed. Use the idCita value of this client\'s ' +
    'confirmed appointment (listed in your instructions), not a date.',
  parameters: {
    type: 'object',
    properties: {
      idCita: {
        type: 'string',
        description: 'The appointment id of one of this client\'s confirmed appointments',
      },
      nuevoInicio: {
        type: 'string',
        description:
          'New start date-time of the appointment in ISO format, e.g. "2026-05-05T15:00:00-05:00"',
      },
    },
    required: ['idCita', 'nuevoInicio'],
  },
}

/** Google Calendar — cancel an appointment and mark it cancelled in the CRM. */
export const CANCELAR_CITA_TOOL: ToolDefinition = {
  name: 'cancelar_cita',
  description:
    'Cancel an existing appointment and mark it cancelled in the CRM.',
  parameters: {
    type: 'object',
    properties: {
      idCita: {
        type: 'string',
        description: 'The appointment id of one of this client\'s confirmed appointments',
      },
    },
    required: ['idCita'],
  },
}

/** Google Calendar — list upcoming events (maxResults=100). */
export const LISTAR_EVENTOS_TOOL: ToolDefinition = {
  name: 'listar_eventos',
  description:
    'List upcoming/oncoming events in the business calendar (default fetch is 100 items, far above the API\'s built-in 5-result cap). ' +
    'Use this when the customer asks "¿qué tengo esta semana?", "¿hay algo agendado?", or to see the full agenda. ' +
    'Available only when Google Calendar is configured.',
  parameters: {
    type: 'object',
    properties: {
      desde: {
        type: 'string',
        description:
          'Start of the window, ISO date or date-time in Bogota time (e.g. "2026-05-04" or "2026-05-04T00:00:00-05:00"). Default: now.',
      },
      hasta: {
        type: 'string',
        description:
          'End of the window, ISO date or date-time in Bogota time. Default: no limit (from `desde` onwards).',
      },
      maxResults: {
        type: 'integer',
        description: 'Number of events to fetch (default 100, max 250)',
      },
    },
  },
}

/** Gmail — send an HTML email from the business inbox. */
export const ENVIAR_CORREO_TOOL: ToolDefinition = {
  name: 'enviar_correo',
  description:
    'Send an email from the business Gmail account via the Gmail API. The body is HTML by default, so it renders nicely on phones. ' +
    'Available only when the Gmail OAuth scope is configured.',
  parameters: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Recipient email address',
      },
      subject: {
        type: 'string',
        description: 'Clear subject line that names the event/cita topic',
      },
      body: {
        type: 'string',
        description:
          'HTML body of the email (e.g. with <strong> for the date/time and a link to the Google Meet room)',
      },
    },
    required: ['to', 'subject', 'body'],
  },
}

/** Gmail — read recent received messages. */
export const LEER_CORREOS_TOOL: ToolDefinition = {
  name: 'leer_correos',
  description:
    'Read recent received messages in the business Gmail inbox (from, subject, date and a snippet; fetches up to 100 messages by default). ' +
    'Use this when the customer asks about incoming emails or confirmations. ' +
    'Available only when the Gmail OAuth scope is configured.',
  parameters: {
    type: 'object',
    properties: {
      maxResults: {
        type: 'integer',
        description: 'Number of messages to fetch (default 100, max 100)',
      },
      query: {
        type: 'string',
        description:
          'Optional Gmail search, e.g. "from:someone@x.com" or "is:unread"',
      },
    },
  },
}

/**
 * Structured result parsed out of agendar_cita's `JSON_RESULT` trailer.
 * Auto-reply uses this to ground the confirmation in the REAL event:
 * even if the model hallucinates a link, we can strip/inject the true one.
 */
export interface BookingToolResult {
  confirmado: boolean
  link: string | null
  inicio: string | null
  idCita: string | null
  /** Fecha (YYYY-MM-DD) y hora (HH:MM) locales devueltas por agendar_cita. */
  fecha: string | null
  hora: string | null
}

/**
 * Parse the `JSON_RESULT` block that agendar_cita appends to its
 * human-readable result. Returns null when there is no trailer (e.g. the
 * tool errored, threw, or was an availability check), so the caller never
 * mistakes a simulated success for a real one.
 */
export function extractBookingResult(output: string): BookingToolResult | null {
  const marker = output.lastIndexOf('JSON_RESULT')
  if (marker === -1) return null
  const start = output.indexOf('{', marker)
  if (start === -1) return null
  try {
    const parsed = JSON.parse(output.slice(start)) as Record<string, unknown>
    return {
      confirmado: parsed.confirmado === true,
      link:
        typeof parsed.link === 'string' && parsed.link.trim()
          ? parsed.link.trim()
          : null,
      inicio: typeof parsed.inicio === 'string' ? parsed.inicio : null,
      idCita: typeof parsed.idCita === 'string' ? parsed.idCita : null,
      fecha: typeof parsed.fecha === 'string' ? parsed.fecha : null,
      hora: typeof parsed.hora === 'string' ? parsed.hora : null,
    }
  } catch {
    return null
  }
}

/** All tools available to the AI agent. */
export const AI_TOOLS: ToolDefinition[] = [
  UPDATE_CLIENT_PROFILE_TOOL,
  VER_DISPONIBILIDAD_TOOL,
  AGENDAR_CITA_TOOL,
  REAGENDAR_CITA_TOOL,
  CANCELAR_CITA_TOOL,
  LISTAR_EVENTOS_TOOL,
  ENVIAR_CORREO_TOOL,
  LEER_CORREOS_TOOL,
]

/**
 * Execute a tool call from the AI model. Returns a human-readable
 * result string to feed back to the model.
 */
export async function executeToolCall(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  toolCall: ToolCall,
): Promise<string> {
  if (toolCall.name === 'update_client_profile') {
    return handleUpdateClientProfile(db, accountId, contactId, toolCall.arguments)
  }
  if (toolCall.name === 'ver_disponibilidad') {
    const { desde, hasta } = toolCall.arguments
    if (typeof desde !== 'string' || typeof hasta !== 'string') {
      return 'Error: ver_disponibilidad requiere "desde" y "hasta" como fechas.'
    }
    return ver_disponibilidad(desde, hasta)
  }
  if (toolCall.name === 'agendar_cita') {
    const { inicio, nombre, motivo, email } = toolCall.arguments
    if (typeof inicio !== 'string' || typeof nombre !== 'string') {
      return 'Error: agendar_cita requiere "inicio" y "nombre".'
    }
    const result = await agendar_cita({
      db,
      accountId,
      contactoId: contactId,
      inicio,
      nombre,
      motivo: typeof motivo === 'string' ? motivo : undefined,
      correoCliente: typeof email === 'string' ? email : undefined,
    })
    console.log('[agendar_cita payload]', result)
    return result
  }
  if (toolCall.name === 'reagendar_cita') {
    const { idCita, nuevoInicio } = toolCall.arguments
    if (typeof idCita !== 'string' || typeof nuevoInicio !== 'string') {
      return 'Error: reagendar_cita requiere "idCita" y "nuevoInicio".'
    }
    return reagendar_cita({ db, accountId, idCita, nuevoInicio })
  }
  if (toolCall.name === 'cancelar_cita') {
    const { idCita } = toolCall.arguments
    if (typeof idCita !== 'string') {
      return 'Error: cancelar_cita requiere "idCita".'
    }
    return cancelar_cita({ db, accountId, idCita })
  }
  if (toolCall.name === 'listar_eventos') {
    const { desde, hasta, maxResults } = toolCall.arguments
    if (desde !== undefined && typeof desde !== 'string') {
      return 'Error: "desde" debe ser un texto de fecha en listar_eventos.'
    }
    if (hasta !== undefined && typeof hasta !== 'string') {
      return 'Error: "hasta" debe ser un texto de fecha en listar_eventos.'
    }
    const parsedMax =
      typeof maxResults === 'number' && Number.isFinite(maxResults)
        ? Math.round(maxResults)
        : undefined
    return listar_eventos({
      desde: typeof desde === 'string' ? desde : undefined,
      hasta: typeof hasta === 'string' ? hasta : undefined,
      maxResults: parsedMax,
    })
  }
  if (toolCall.name === 'enviar_correo') {
    const { to, subject, body } = toolCall.arguments
    if (typeof to !== 'string' || typeof subject !== 'string' || typeof body !== 'string') {
      return 'Error: enviar_correo requiere "to" (destinatario), "subject" (asunto) y "body" (mensaje HTML).'
    }
    if (!gmailConfigured()) {
      return 'Error: Gmail no está configurado (faltan GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN con alcance de Gmail).'
    }
    return enviar_correo({ to: to.trim(), subject: subject.trim(), html: body })
  }
  if (toolCall.name === 'leer_correos') {
    const { maxResults, query } = toolCall.arguments
    if (!gmailConfigured()) {
      return 'Error: Gmail no está configurado (faltan GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN con alcance de Gmail).'
    }
    const parsedMax =
      typeof maxResults === 'number' && Number.isFinite(maxResults)
        ? Math.round(maxResults)
        : undefined
    return leer_correos({
      maxResults: parsedMax,
      query: typeof query === 'string' && query.trim() ? query.trim() : undefined,
    })
  }
  return `Unknown tool: ${toolCall.name}`
}

async function handleUpdateClientProfile(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const updates: Record<string, string> = {}

  if (typeof args.name === 'string' && args.name.trim()) {
    updates.name = args.name.trim()
  }
  if (typeof args.email === 'string' && args.email.trim()) {
    updates.email = args.email.trim()
  }
  if (typeof args.location === 'string' && args.location.trim()) {
    updates.company = args.location.trim()
  }
  if (typeof args.project_type === 'string' && args.project_type.trim()) {
    updates.avatar_url = args.project_type.trim()
  }

  if (Object.keys(updates).length === 0) {
    return 'No profile data to update.'
  }

  updates.updated_at = new Date().toISOString()

  const { error } = await db
    .from('contacts')
    .update(updates)
    .eq('id', contactId)
    .eq('account_id', accountId)

  if (error) {
    console.error('[ai tools] update_client_profile failed:', error)
    return `Failed to update profile: ${error.message}`
  }

  const fields = Object.keys(updates)
    .filter((k) => k !== 'updated_at')
    .join(', ')
  return `Profile updated: ${fields}`
}

/**
 * Contact context loaded for the system prompt: profile fields plus the
 * contact's currently-confirmed appointments so the model can pick the
 * right `idCita` for reagendar_cita / cancelar_cita.
 */
export interface ContactContext {
  name: string | null
  email: string | null
  location: string | null
  citas: { id: string; fecha_inicio: string; estado: string }[]
}

/**
 * Load the contact record (profile + active citas) for context
 * injection into the system prompt.
 */
export async function loadContactContext(
  db: SupabaseClient,
  contactId: string,
): Promise<ContactContext | null> {
  const [{ data, error }, { data: citas }] = await Promise.all([
    db
      .from('contacts')
      .select('name, email, company')
      .eq('id', contactId)
      .maybeSingle(),
    db
      .from('citas')
      .select('id, fecha_inicio, estado')
      .eq('contact_id', contactId)
      .eq('estado', 'confirmada'),
  ])

  if (error || !data) return null

  return {
    name: data.name ?? null,
    email: data.email ?? null,
    location: data.company ?? null,
    citas: Array.isArray(citas) ? citas : [],
  }
}
