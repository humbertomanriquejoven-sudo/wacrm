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
    'Guarda o actualiza el perfil del cliente cuando comparte información personal durante la conversación. ' +
    'Invocála siempre que el cliente mencione su nombre, correo, ubicación (ciudad/barrio), tipo de proyecto o presupuesto. ' +
    'Puedes llamarla varias veces a medida que llega información nueva.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Nombre completo del cliente (p. ej. "Carlos Pérez")',
      },
      email: {
        type: 'string',
        description: 'Dirección de correo del cliente',
      },
      location: {
        type: 'string',
        description:
          'Ciudad, barrio o dirección del cliente (p. ej. "Bogotá", "Chía", "Cajicá")',
      },
      project_type: {
        type: 'string',
        description:
          'Tipo de proyecto o servicio que interesa al cliente (p. ej. "remodelación", "diseño interior", "renders 3D")',
      },
      budget: {
        type: 'string',
        description:
          'Presupuesto o rango de precio mencionado por el cliente (p. ej. "15 millones", "5-8 millones COP")',
      },
    },
  },
}

/** Google Calendar — list free 45-minute slots within business hours. */
export const VER_DISPONIBILIDAD_TOOL: ToolDefinition = {
  name: 'ver_disponibilidad',
  description:
    'Lista los horarios libres para citas de 45 minutos en el calendario del negocio. ' +
    'Llámala SOLO cuando el cliente aún NO haya elegido fecha/hora y necesites mostrarle horarios disponibles. ' +
    'Si el cliente YA dio una fecha y hora concretas, agenda directamente con agendar_cita sin pasar por esta herramienta. ' +
    'Horario de atención: lunes a domingo de 08:00-23:00 (America/Bogotá, UTC-5). ' +
    'Acepta también una hora puntual en "desde" (p. ej. "2026-09-18T18:00:00-05:00") y la interpreta automáticamente como el rango de 45 minutos 18:00-18:45. ' +
    'Pasa el rango de fechas (desde/hasta) que el cliente esté preguntando.',
  parameters: {
    type: 'object',
    properties: {
      desde: {
        type: 'string',
        description:
          'Inicio de la ventana a consultar, fecha u hora ISO en hora de Bogotá (p. ej. "2026-05-04" o "2026-05-04T09:00:00-05:00"). También acepta una hora puntual (p. ej. "2026-05-04T18:00:00-05:00").',
      },
      hasta: {
        type: 'string',
        description:
          'Fin de la ventana a consultar, fecha ISO en hora de Bogotá (p. ej. "2026-05-08")',
      },
    },
    required: ['desde', 'hasta'],
  },
}

/** Google Calendar — book a 45-minute appointment and link it to the contact. */
export const AGENDAR_CITA_TOOL: ToolDefinition = {
  name: 'agendar_cita',
  description:
    'Agenda una reunión de 45 minutos para el cliente en el calendario del negocio. ' +
    'LLÁMALA DE INMEDIATO en cuanto el cliente indique una fecha y hora concretas (p. ej. "mañana a las 6 pm"): ' +
    'no vuelvas a preguntar la fecha, no preguntes "cuál horario prefiere", no pidas un rango de hora de inicio/fin ni pidas confirmar la hora elegida. ' +
    'Convierte la hora del cliente al ISO de Bogotá en el mismo turno (p. ej. "mañana a las 6 pm" → 2026-09-18T18:00:00-05:00). ' +
    'motivo es opcional y por defecto es "Consulta / Valoración" cuando se omite. ' +
    'Google crea un enlace de Meet (o devuelve la URL del evento del calendario como respaldo) y envía al cliente una invitación por correo. ' +
    'Pasa el correo del cliente cuando lo conozcas, para que reciba la invitación con el enlace. ' +
    'Al éxito, la herramienta devuelve confirmado:true más el enlace exacto (hangoutLink o htmlLink; meet.google.com/new como último respaldo) para compartir con el cliente. ' +
    'El mensaje de confirmación por WhatsApp al cliente DEBE incluir SIEMPRE el enlace de Google Meet — nunca envíes una confirmación de cita sin él.',
  parameters: {
    type: 'object',
    properties: {
      inicio: {
        type: 'string',
        description:
          'Fecha-hora de inicio de la cita en ISO 8601 con el offset de Bogotá, p. ej. "2026-05-04T10:00:00-05:00"',
      },
      nombre: {
        type: 'string',
        description: 'Nombre del cliente que se pondrá en el evento del calendario',
      },
      motivo: {
        type: 'string',
        description:
          'Motivo o tema de la cita (p. ej. "cotización de interiores"). Opcional: por defecto es "Consulta / Valoración", así que nunca bloquees la cita preguntándolo.',
      },
      email: {
        type: 'string',
        description:
          'Correo del cliente, usado para enviar la invitación de Google Calendar con el enlace de Meet (opcional — nunca bloquees la cita si no lo tienes)',
      },
    },
    required: ['inicio', 'nombre'],
  },
}

/** Google Calendar — move an existing appointment to another slot. */
export const REAGENDAR_CITA_TOOL: ToolDefinition = {
  name: 'reagendar_cita',
  description:
    'Mueve una cita existente a una nueva hora de inicio. ' +
    'Llama ver_disponibilidad primero para encontrar un horario libre; el horario actual de la cita se excluye de las verificaciones de disponibilidad, ' +
    'así que es válido moverla de vuelta a su hora actual. ' +
    'Usa el valor idCita de la cita confirmada de este cliente (listado en tus instrucciones), no una fecha.',
  parameters: {
    type: 'object',
    properties: {
      idCita: {
        type: 'string',
        description: 'El id de una de las citas confirmadas de este cliente',
      },
      nuevoInicio: {
        type: 'string',
        description:
          'Nueva fecha-hora de inicio de la cita en formato ISO, p. ej. "2026-05-05T15:00:00-05:00"',
      },
    },
    required: ['idCita', 'nuevoInicio'],
  },
}

/** Google Calendar — cancel an appointment and mark it cancelled in the CRM. */
export const CANCELAR_CITA_TOOL: ToolDefinition = {
  name: 'cancelar_cita',
  description:
    'Cancela una cita existente y la marca como cancelada en el CRM.',
  parameters: {
    type: 'object',
    properties: {
      idCita: {
        type: 'string',
        description: 'El id de una de las citas confirmadas de este cliente',
      },
    },
    required: ['idCita'],
  },
}

/** Google Calendar — list upcoming events (maxResults=100). */
export const LISTAR_EVENTOS_TOOL: ToolDefinition = {
  name: 'listar_eventos',
  description:
    'Lista los eventos próximos del calendario del negocio (por defecto recupera 100 elementos, muy por encima del límite interno de 5 resultados de la API). ' +
    'Úsala cuando el cliente pregunte "¿qué tengo esta semana?", "¿hay algo agendado?" o para ver la agenda completa. ' +
    'Solo disponible cuando Google Calendar está configurado.',
  parameters: {
    type: 'object',
    properties: {
      desde: {
        type: 'string',
        description:
          'Inicio de la ventana, fecha u hora ISO en hora de Bogotá (p. ej. "2026-05-04" o "2026-05-04T00:00:00-05:00"). Por defecto: ahora.',
      },
      hasta: {
        type: 'string',
        description:
          'Fin de la ventana, fecha u hora ISO en hora de Bogotá. Por defecto: sin límite (desde `desde` en adelante).',
      },
      maxResults: {
        type: 'integer',
        description: 'Cantidad de eventos a recuperar (por defecto 100, máximo 250)',
      },
    },
  },
}

/** Gmail — send an HTML email from the business inbox. */
export const ENVIAR_CORREO_TOOL: ToolDefinition = {
  name: 'enviar_correo',
  description:
    'Envía un correo desde la cuenta de Gmail del negocio mediante la API de Gmail. El cuerpo es HTML por defecto, así que se ve bien en el teléfono. ' +
    'Solo disponible cuando el alcance OAuth de Gmail está configurado.',
  parameters: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Dirección de correo del destinatario',
      },
      subject: {
        type: 'string',
        description: 'Asunto claro que nombre el evento/tema de la cita',
      },
      body: {
        type: 'string',
        description:
          'Cuerpo HTML del correo (p. ej. con <strong> para la fecha/hora y un enlace a la sala de Google Meet)',
      },
    },
    required: ['to', 'subject', 'body'],
  },
}

/** Gmail — read recent received messages. */
export const LEER_CORREOS_TOOL: ToolDefinition = {
  name: 'leer_correos',
  description:
    'Lee mensajes recientes recibidos en la bandeja de entrada de Gmail del negocio (de, asunto, fecha y un extracto; recupera hasta 100 mensajes por defecto). ' +
    'Úsala cuando el cliente pregunte por correos o confirmaciones entrantes. ' +
    'Solo disponible cuando el alcance OAuth de Gmail está configurado.',
  parameters: {
    type: 'object',
    properties: {
      maxResults: {
        type: 'integer',
        description: 'Cantidad de mensajes a recuperar (por defecto 100, máximo 100)',
      },
      query: {
        type: 'string',
        description:
          'Búsqueda opcional de Gmail, p. ej. "from:alguien@x.com" o "is:unread"',
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
  return `Herramienta desconocida: ${toolCall.name}`
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
    return 'No hay datos de perfil para actualizar.'
  }

  updates.updated_at = new Date().toISOString()

  const { error } = await db
    .from('contacts')
    .update(updates)
    .eq('id', contactId)
    .eq('account_id', accountId)

  if (error) {
    console.error('[ai tools] update_client_profile failed:', error)
    return `No se pudo actualizar el perfil: ${error.message}`
  }

  const fields = Object.keys(updates)
    .filter((k) => k !== 'updated_at')
    .join(', ')
  return `Perfil actualizado: ${fields}`
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
