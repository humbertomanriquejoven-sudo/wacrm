import { gmail as gmailV1 } from '@googleapis/gmail'
import { OAuth2Client } from 'google-auth-library'

// ============================================================
// Google Gmail helpers for the AI assistant.
//
// Uses the same OAuth2 (installed-app) credentials as the calendar
// (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN), so the
// refresh token must be generated with a Gmail scope enabled:
//   - https://www.googleapis.com/auth/gmail.send     (send mail)
//   - https://www.googleapis.com/auth/gmail.readonly (read mail)
//
// Sends are addressed to the account that owns the refresh token
// (the `userId: 'me'` of the Gmail API), so the confirmation emails and
// any custom mail the model sends always come from that Gmail inbox.
// ============================================================

const GMAIL_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? ''
const GMAIL_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? ''
const GMAIL_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN ?? ''
const GMAIL_USER = process.env.GMAIL_USER_ID?.trim() || 'me'

/** Strict per-call timeout for Gmail network calls. */
const GMAIL_TIMEOUT_MS = 10_000

/** IANA zone used to format dates/times in emails. */
const GMAIL_TIMEZONE = 'America/Bogota'

/** Whether the Gmail OAuth env vars are set (mail tools are available). */
export function gmailConfigured(): boolean {
  return Boolean(
    GMAIL_CLIENT_ID.trim() &&
      GMAIL_CLIENT_SECRET.trim() &&
      GMAIL_REFRESH_TOKEN.trim(),
  )
}

function gmailClient() {
  if (!gmailConfigured()) {
    throw new Error(
      'Google Gmail is not configured: set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN (OAuth2) with a Gmail scope.',
    )
  }
  const auth = new OAuth2Client({
    clientId: GMAIL_CLIENT_ID,
    clientSecret: GMAIL_CLIENT_SECRET,
  })
  auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN })
  return gmailV1({ version: 'v1', auth })
}

// ------------------------------------------------------------
// Small MIME helpers
// ------------------------------------------------------------

/** RFC 2047 encode a header value (e.g. Subject with accents). */
function encodeHeader(value: string): string {
  return /[^\x20-\x7e]/.test(value)
    ? `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
    : value
}

/** Build a multipart/alternative RFC 2822 message with text + HTML bodies. */
function buildMime(to: string, subject: string, html: string, text: string): string {
  const boundary = `wacrm-${Date.now().toString(36)}`
  const lines = [
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    text,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
    '',
    `--${boundary}--`,
  ]
  return lines.join('\r\n')
}

// ------------------------------------------------------------
// Public entry points
// ------------------------------------------------------------

export interface EnviarCorreoArgs {
  to: string
  subject: string
  /** HTML body. Plain-text fallback is derived from the HTML/`text`. */
  html?: string
  text?: string
}

/**
 * enviar_correo — send an HTML (or plain) email via the Gmail API.
 * Returns a human-readable confirmation for the model to relay.
 */
export async function enviar_correo(
  args: EnviarCorreoArgs,
): Promise<string> {
  const to = args.to?.trim()
  const subject = args.subject?.trim()
  if (!to || !subject) {
    return 'Error: enviar_correo requiere "to" (destinatario) y "subject" (asunto).'
  }
  const html = args.html?.trim() || ''
  const text =
    args.text?.trim() ||
    html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() ||
    subject

  let raw: string
  try {
    raw = Buffer.from(buildMime(to, subject, html, text), 'utf8').toString(
      'base64url',
    )
  } catch (err) {
    return `Error: no se pudo componer el correo: ${err instanceof Error ? err.message : String(err)}`
  }

  const gmail = gmailClient()
  try {
    const res = await gmail.users.messages.send(
      { userId: GMAIL_USER, requestBody: { raw } },
      { timeout: GMAIL_TIMEOUT_MS },
    )
    return `Correo enviado a ${to} (Gmail message id ${res.data.id ?? 'desconocida'}).`
  } catch (err) {
    console.error('[gmail] messages.send failed:', err)
    return `Error: Gmail no pudo enviar el correo a ${to}.`
  }
}

export interface LeerCorreosArgs {
  /** Number of messages to fetch (default/ceiling 100, "me" sent first). */
  maxResults?: number
  /** Optional Gmail search query, e.g. "from:cliente@x.com is:unread". */
  query?: string
}

/**
 * leer_correos — list recent inbox messages (from/subject/date + snippet)
 * so the model can answer "did the customer write me?" style questions.
 */
export async function leer_correos(
  args: LeerCorreosArgs = {},
): Promise<string> {
  const maxResults = Math.min(Math.max(1, args.maxResults ?? 100), 100)
  const gmail = gmailClient()
  try {
    const list = await gmail.users.messages.list(
      {
        userId: GMAIL_USER,
        maxResults,
        q: args.query?.trim() || undefined,
      },
      { timeout: GMAIL_TIMEOUT_MS },
    )
    const ids = (list.data.messages ?? []).map((m) => m.id).filter(
      (id): id is string => Boolean(id),
    )
    if (ids.length === 0) {
      return 'No hay correos recibidos para esa consulta.'
    }

    const details = await Promise.all(
      ids.map(async (id) => {
        try {
          const { data } = await gmail.users.messages.get(
            {
              userId: GMAIL_USER,
              id,
              format: 'metadata',
              metadataHeaders: ['From', 'Subject', 'Date'],
            },
            { timeout: GMAIL_TIMEOUT_MS },
          )
          const headers =
            data.payload?.headers?.reduce<Record<string, string>>((acc, h) => {
              if (h.name && h.value) acc[h.name] = h.value
              return acc
            }, {}) ?? {}
          return {
            id,
            from: headers.From ?? '?',
            subject: headers.Subject ?? '(sin asunto)',
            date: headers.Date ?? '',
            snippet: data.snippet ?? '',
          }
        } catch {
          return null
        }
      }),
    )

    const lines = details
      .filter((m): m is NonNullable<typeof m> => m !== null)
      .map(
        (m) =>
          `- De: ${m.from}\n  Asunto: ${m.subject}\n  Fecha: ${m.date}\n  Extracto: ${m.snippet}`,
      )
    if (lines.length === 0) return 'No se pudieron leer los correos.'
    return lines.join('\n')
  } catch (err) {
    console.error('[gmail] messages.list/get failed:', err)
    return 'Error: Gmail no pudo consultar los correos.'
  }
}

// ------------------------------------------------------------
// Appointment confirmation email (auto-sent after agendar_cita)
// ------------------------------------------------------------

function formatBogota(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: GMAIL_TIMEZONE,
    dateStyle: 'full',
    timeStyle: 'short',
    hour12: true,
  }).format(d)
}

export interface CitaEmailArgs {
  to: string
  nombre?: string
  motivo?: string
  inicioIso: string
  duracionMin: number
  meetUrl?: string | null
}

/**
 * Send the HTML confirmation email for a booked appointment (date, exact
 * time and direct Google Meet link). Never throws — Gmail failure must not
 * undo an already-created calendar event.
 */
export async function enviarConfirmacionCita(
  args: CitaEmailArgs,
): Promise<string> {
  if (!gmailConfigured()) {
    console.warn('[gmail] no config — confirmation email skipped.')
    return ''
  }
  const { to, nombre, motivo, inicioIso, duracionMin, meetUrl } = args
  const when = formatBogota(inicioIso)
  const topic = motivo?.trim() || nombre?.trim() || 'reunión'

  const text = [
    'Hola,',
    '',
    `Te confirmamos tu ${topic} con nosotros el día ${when}.`,
    duracionMin ? `Duración estimada: ${duracionMin} minutos.` : '',
    meetUrl ? `Enlace directo de Google Meet: ${meetUrl}` : '',
    '',
    'Cualquier cambio, escríbenos por WhatsApp.',
  ].join('\n')

  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222;max-width:520px;margin:0 auto;">',
    '<h2 style="color:#0b6bcb;margin:0 0 12px;">Confirmación de cita</h2>',
    `<p>Hola${nombre ? ` <strong>${escapeHtml(nombre)}</strong>` : ''},</p>`,
    `<p>Te confirmamos tu <strong>${escapeHtml(topic)}</strong> el día <strong>${escapeHtml(when)}</strong>.</p>`,
    duracionMin ? `<p>Duración estimada: <strong>${duracionMin} minutos</strong>.</p>` : '',
    meetUrl
      ? `<p>Enlace directo de tu reunión de <strong>Google Meet</strong>:<br/><a href="${escapeAttr(meetUrl)}">${escapeHtml(meetUrl)}</a></p>`
      : '',
    '<p style="margin-top:20px;color:#666;">Cualquier cambio, escríbenos por WhatsApp. ¡Te esperamos!</p>',
    '</div>',
  ].join('')

  try {
    return await enviar_correo({
      to,
      subject: `Confirmación de cita — ${topic}`,
      html,
      text,
    })
  } catch (err) {
    console.error('[gmail] confirmation email failed:', err)
    return ''
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, '&#39;')
}