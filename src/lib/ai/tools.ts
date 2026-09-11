import type { SupabaseClient } from '@supabase/supabase-js'
import type { ToolDefinition, ToolCall } from './types'
import {
  agendar_cita,
  cancelar_cita,
  reagendar_cita,
  ver_disponibilidad,
} from '@/lib/calendar'

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

/** Google Calendar — list free 60-minute slots within business hours. */
export const VER_DISPONIBILIDAD_TOOL: ToolDefinition = {
  name: 'ver_disponibilidad',
  description:
    'List available appointment slots in the business calendar. ' +
    'Call this BEFORE agendar_cita or reagendar_cita to confirm the customer\'s requested date/time. ' +
    'Business hours: Monday to Friday 09:00-18:00, Saturday 09:00-13:00 (America/Lima). ' +
    'Pass the date range the customer is asking about.',
  parameters: {
    type: 'object',
    properties: {
      desde: {
        type: 'string',
        description:
          'Start of the window to check, ISO date or date-time (e.g. "2026-05-04" or "2026-05-04T09:00:00-05:00")',
      },
      hasta: {
        type: 'string',
        description:
          'End of the window to check, ISO date or date-time (e.g. "2026-05-08")',
      },
    },
    required: ['desde', 'hasta'],
  },
}

/** Google Calendar — book a 60-minute appointment and link it to the contact. */
export const AGENDAR_CITA_TOOL: ToolDefinition = {
  name: 'agendar_cita',
  description:
    'Schedule a 60-minute appointment for the customer in the business calendar and save it in the CRM.',
  parameters: {
    type: 'object',
    properties: {
      inicio: {
        type: 'string',
        description:
          'Start date-time of the appointment in ISO format, e.g. "2026-05-04T10:00:00-05:00"',
      },
      nombre: {
        type: 'string',
        description: 'Customer name to put on the calendar event',
      },
      motivo: {
        type: 'string',
        description:
          'Reason or topic of the appointment (e.g. "cotización de interiores")',
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

/** All tools available to the AI agent. */
export const AI_TOOLS: ToolDefinition[] = [
  UPDATE_CLIENT_PROFILE_TOOL,
  VER_DISPONIBILIDAD_TOOL,
  AGENDAR_CITA_TOOL,
  REAGENDAR_CITA_TOOL,
  CANCELAR_CITA_TOOL,
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
    const { inicio, nombre, motivo } = toolCall.arguments
    if (typeof inicio !== 'string' || typeof nombre !== 'string') {
      return 'Error: agendar_cita requiere "inicio" y "nombre".'
    }
    return agendar_cita({
      db,
      accountId,
      contactoId: contactId,
      inicio,
      nombre,
      motivo: typeof motivo === 'string' ? motivo : undefined,
    })
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
