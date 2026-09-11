import { calendar as calendarV3 } from '@googleapis/calendar'
import { JWT } from 'google-auth-library'
import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Google Calendar booking helpers.
//
// Four Spanish-named entry points, one per AI tool:
//   ver_disponibilidad(desde, hasta)  -> free slots text
//   agendar_cita(opts)                -> create event + DB row
//   reagendar_cita(opts)              -> PATCH event + DB row
//   cancelar_cita(opts)               -> delete event + mark DB row
//
// Calendar = Google Calendar v3 (shared calendar). DB = `citas`
// table (migration 042). The calendar is the source of truth for
// the event; `citas` links it to a CRM contact so the AI/bot can
// PATCH/cancel by stable UUID.
//
// Business hours are fixed (America/Lima):
//   Mon-Fri 09:00-18:00, Sat 09:00-13:00, Sun closed.
// ============================================================

const CAL_ID = process.env.GOOGLE_CALENDAR_ID ?? ''
const SVC_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? ''

const CAL_TIMEZONE = 'America/Lima'
export const APPOINTMENT_DURATION_MIN = 60

/**
 * Strict per-request timeout for every Google Calendar network call. A
 * hung freebusy/event call must not block the AI tool round (or the
 * webhook pipeline); it fails fast and the tool returns a readable
 * error instead of stalling the bot.
 */
const CALENDAR_TIMEOUT_MS = 5_000

export const BUSINESS_HOURS: Record<
  number,
  { openMin: number; closeMin: number } | undefined
> = {
  1: { openMin: 9 * 60, closeMin: 18 * 60 },
  2: { openMin: 9 * 60, closeMin: 18 * 60 },
  3: { openMin: 9 * 60, closeMin: 18 * 60 },
  4: { openMin: 9 * 60, closeMin: 18 * 60 },
  5: { openMin: 9 * 60, closeMin: 18 * 60 },
  6: { openMin: 9 * 60, closeMin: 13 * 60 },
}

function isCalendarConfigured(): boolean {
  return Boolean(CAL_ID.trim() && SVC_JSON.trim())
}

/** Whether the Google Calendar env vars are set (tools are available). */
export function calendarConfigured(): boolean {
  return isCalendarConfigured()
}

function calendarClient() {
  if (!isCalendarConfigured()) {
    throw new Error(
      'Google Calendar is not configured: set GOOGLE_CALENDAR_ID and GOOGLE_SERVICE_ACCOUNT_JSON.',
    )
  }

  let creds: {
    client_email?: string
    private_key?: string
  }
  try {
    creds = JSON.parse(SVC_JSON) as {
      client_email?: string
      private_key?: string
    }
  } catch (err) {
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  // The JSON may have kept the private key double-escaped (\\n); the
  // JWT client needs real newlines.
  const privateKey = (creds.private_key ?? '').replace(/\\n/g, '\n').trim()

  const auth = new JWT({
    email: creds.client_email,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  })

  return calendarV3({ version: 'v3', auth })
}

// ------------------------------------------------------------
// Lima wall-clock helpers (America/Lima is UTC-5, no DST, but we
// still resolve the offset from the tz database rather than assume).
// ------------------------------------------------------------

const limaWallFmt = new Intl.DateTimeFormat('en', {
  timeZone: CAL_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
  hour12: false,
})

interface LimaParts {
  year: number
  month: number // 1-12
  day: number
  hour: number
  minute: number
  second: number
  weekday: number // 0=Sun .. 6=Sat
}

function limaParts(instant: Date): LimaParts {
  const parts = Object.fromEntries(
    limaWallFmt
      .formatToParts(instant)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  )
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
      parts.weekday,
    ),
  }
}

/** RFC3339 (offset -05:00) of `instant` expressed in Lima wall time. */
function limaIso(instant: Date): string {
  const p = limaParts(instant)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}-05:00`
}

function limaDateKey(instant: Date): string {
  return limaIso(instant).slice(0, 10)
}

/** Instant whose Lima wall clock equals the given date + minute-of-day. */
function instantFromLimaWall(dateKey: string, minuteOfDay: number): Date {
  const [y, m, d] = dateKey.split('-').map(Number)
  const h = Math.floor(minuteOfDay / 60)
  const min = minuteOfDay % 60
  const approxUtc = new Date(Date.UTC(y, m - 1, d, h, min, 0, 0))
  const offsetMin = limaParts(approxUtc).hour * 60 + limaParts(approxUtc).minute - (h * 60 + min)
  return new Date(approxUtc.getTime() - offsetMin * 60_000)
}

// ------------------------------------------------------------
// Free/busy queries
// ------------------------------------------------------------

interface BusyInterval {
  start: Date
  end: Date
}

/** True when interval `a` is fully contained in interval `b`. */
function isInside(a: BusyInterval, b: BusyInterval): boolean {
  return a.start.getTime() >= b.start.getTime() && a.end.getTime() <= b.end.getTime()
}

async function fetchBusy(
  from: Date,
  to: Date,
  exclude?: BusyInterval | null,
): Promise<BusyInterval[]> {
  const cal = calendarClient()
  const res = await cal.freebusy.query({
    requestBody: {
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      timeZone: CAL_TIMEZONE,
      items: [{ id: CAL_ID }],
    },
  }, { timeout: CALENDAR_TIMEOUT_MS })
  const busy = res.data.calendars?.[CAL_ID]?.busy ?? []
  return busy
    .filter((b) => b.start && b.end)
    .map((b) => ({ start: new Date(b.start!), end: new Date(b.end!) }))
    .filter((b) => !exclude || !isInside(b, exclude))
    .sort((a, b) => a.start.getTime() - b.start.getTime())
}

function overlaps(slotStart: Date, slotEnd: Date, busy: BusyInterval[]): boolean {
  return busy.some((b) => slotStart.getTime() < b.end.getTime() && slotEnd.getTime() > b.start.getTime())
}

/**
 * ver_disponibilidad(desde, hasta) — list free 60-minute slots within
 * business hours that fall inside the given window. `desde`/`hasta`
 * are ISO date-times (or date-only, interpreted as the full day).
 * Returns a human-readable summary for the model to relay or use.
 */
export async function ver_disponibilidad(
  desde: string,
  hasta: string,
): Promise<string> {
  const from = parseWindowBound(desde, /* isEnd */ false)
  const to = parseWindowBound(hasta, /* isEnd */ true)
  if (from.getTime() >= to.getTime()) {
    return 'Error: el rango "desde" debe ser anterior a "hasta".'
  }

  let busy: BusyInterval[]
  try {
    busy = await fetchBusy(from, to)
  } catch (err) {
    console.error('[calendar] freebusy failed:', err)
    return 'Error: no se pudo consultar la disponibilidad del calendario.'
  }

  const slots: Date[] = []
  const seenDays = new Set<string>()
  for (
    let t = from.getTime();
    t <= to.getTime() + 24 * 60 * 60 * 1000;
    t += 12 * 60 * 60 * 1000
  ) {
    const day = limaDateKey(new Date(t))
    if (seenDays.has(day)) continue
    seenDays.add(day)

    const parts = limaParts(new Date(t))
    const hours = BUSINESS_HOURS[parts.weekday]
    if (!hours) continue

    for (
      let startMin = hours.openMin;
      startMin + APPOINTMENT_DURATION_MIN <= hours.closeMin;
      startMin += 30
    ) {
      const slotStart = instantFromLimaWall(day, startMin)
      const slotEnd = new Date(
        slotStart.getTime() + APPOINTMENT_DURATION_MIN * 60_000,
      )
      if (slotStart.getTime() < from.getTime()) continue
      if (slotEnd.getTime() > to.getTime()) continue
      if (overlaps(slotStart, slotEnd, busy)) continue
      slots.push(slotStart)
    }
  }

  if (slots.length === 0) {
    return 'No hay horarios disponibles en el rango solicitado.'
  }

  const byDay = new Map<string, Date[]>()
  for (const s of slots) {
    const key = limaDateKey(s)
    byDay.set(key, [...(byDay.get(key) ?? []), s])
  }

  const lines: string[] = ['Horarios disponibles (hora Lima):']
  for (const [day, daySlots] of [...byDay.entries()].sort()) {
    const p = limaParts(daySlots[0])
    const weekdayName = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][p.weekday]
    lines.push(
      `${weekdayName} ${day}: ${daySlots
        .map((s) => limaIso(s))
        .join(', ')}`,
    )
  }
  return lines.join('\n')
}

// ------------------------------------------------------------
// Lifecycle: create / reschedule / cancel
// ------------------------------------------------------------

export interface AgendarCitaArgs {
  db: SupabaseClient
  accountId: string
  contactoId: string
  inicio: string
  nombre: string
  motivo?: string
}

/** agendar_cita — create a 60-minute event and persist the CRM row. */
export async function agendar_cita(
  args: AgendarCitaArgs,
): Promise<string> {
  const { db, accountId, contactoId, inicio, nombre, motivo } = args
  const start = parseAppointmentStart(inicio)
  if (start === null) {
    return 'Error: "inicio" no es una fecha válida o cae fuera del horario de atención.'
  }

  try {
    const busy = await fetchBusy(start, new Date(start.getTime() + APPOINTMENT_DURATION_MIN * 60_000))
    if (busy.length > 0) {
      return 'Error: ese horario ya está ocupado. Consulta ver_disponibilidad antes de agendar.'
    }
  } catch (err) {
    console.error('[calendar] agendar freebusy failed:', err)
    return 'Error: no se pudo confirmar el horario en el calendario.'
  }

  const cal = calendarClient()
  const name = nombre.trim() || 'Cita'
  const title = motivo && motivo.trim() ? `${name} — ${motivo.trim()}` : name

  let event: { id?: string | null }
  try {
    const created = await cal.events.insert({
      calendarId: CAL_ID,
      requestBody: {
        summary: title,
        description: motivo?.trim() || undefined,
        start: { dateTime: limaIso(start), timeZone: CAL_TIMEZONE },
        end: {
          dateTime: limaIso(new Date(start.getTime() + APPOINTMENT_DURATION_MIN * 60_000)),
          timeZone: CAL_TIMEZONE,
        },
      },
    }, { timeout: CALENDAR_TIMEOUT_MS })
    event = { id: created.data.id }
  } catch (err) {
    console.error('[calendar] events.insert failed:', err)
    return 'Error: Google Calendar rechazó la creación de la cita.'
  }

  const { error } = await db
    .from('citas')
    .insert({
      account_id: accountId,
      contact_id: contactoId,
      google_event_id: event.id ?? '',
      fecha_inicio: start.toISOString(),
      fecha_fin: new Date(start.getTime() + APPOINTMENT_DURATION_MIN * 60_000).toISOString(),
      estado: 'confirmada',
      motivo: motivo?.trim() || null,
    })
    .select('id')
    .single()

  if (error) {
    console.error('[calendar] citas insert failed:', error)
    return `Error: la cita se creó en Google Calendar pero no se pudo guardar en el CRM (${error.message}).`
  }

  return `Cita agendada: ${limaIso(start)} (60 minutos), cliente: ${name}.`
}

export interface ReagendarCitaArgs {
  db: SupabaseClient
  accountId: string
  idCita: string
  nuevoInicio: string
}

/** reagendar_cita — move an existing appointment to a new start time. */
export async function reagendar_cita(
  args: ReagendarCitaArgs,
): Promise<string> {
  const { db, accountId, idCita, nuevoInicio } = args
  const start = parseAppointmentStart(nuevoInicio)
  if (start === null) {
    return 'Error: "nuevoInicio" no es una fecha válida o cae fuera del horario de atención.'
  }

  const { data: cita, error: findErr } = await db
    .from('citas')
    .select('id, google_event_id, account_id, fecha_inicio')
    .eq('id', idCita)
    .eq('account_id', accountId)
    .maybeSingle()
  if (findErr || !cita) {
    return 'Error: no se encontró la cita indicada.'
  }

  // The event being moved still occupies its current slot in the
  // calendar until we PATCH it, so its own window must not count as
  // "busy" when checking availability for the new start time.
  const oldStart = new Date(cita.fecha_inicio)
  const oldInterval: BusyInterval | null =
    Number.isNaN(oldStart.getTime())
      ? null
      : {
          start: oldStart,
          end: new Date(
            oldStart.getTime() + APPOINTMENT_DURATION_MIN * 60_000,
          ),
        }

  try {
    const busy = await fetchBusy(
      start,
      new Date(start.getTime() + APPOINTMENT_DURATION_MIN * 60_000),
      oldInterval,
    )
    if (busy.length > 0) {
      return 'Error: ese horario ya está ocupado. Consulta ver_disponibilidad antes de reagendar.'
    }
  } catch (err) {
    console.error('[calendar] reagendar freebusy failed:', err)
    return 'Error: no se pudo confirmar el horario en el calendario.'
  }

  const cal = calendarClient()
  try {
    await cal.events.patch({
      calendarId: CAL_ID,
      eventId: cita.google_event_id,
      requestBody: {
        start: { dateTime: limaIso(start), timeZone: CAL_TIMEZONE },
        end: {
          dateTime: limaIso(new Date(start.getTime() + APPOINTMENT_DURATION_MIN * 60_000)),
          timeZone: CAL_TIMEZONE,
        },
      },
    }, { timeout: CALENDAR_TIMEOUT_MS })
  } catch (err) {
    console.error('[calendar] events.patch failed:', err)
    return 'Error: Google Calendar no pudo reagendar la cita.'
  }

  const { error } = await db
    .from('citas')
    .update({
      fecha_inicio: start.toISOString(),
      fecha_fin: new Date(start.getTime() + APPOINTMENT_DURATION_MIN * 60_000).toISOString(),
    })
    .eq('id', idCita)
    .eq('account_id', accountId)
  if (error) {
    console.error('[calendar] citas update failed:', error)
    return `Error: el evento se movió en Google Calendar pero no se pudo actualizar el CRM (${error.message}).`
  }

  return `Cita reagendada para: ${limaIso(start)} (60 minutos).`
}

export interface CancelarCitaArgs {
  db: SupabaseClient
  accountId: string
  idCita: string
}

/** cancelar_cita — delete the remote event and mark the row 'cancelada'. */
export async function cancelar_cita(
  args: CancelarCitaArgs,
): Promise<string> {
  const { db, accountId, idCita } = args

  const { data: cita, error: findErr } = await db
    .from('citas')
    .select('id, google_event_id, account_id, estado')
    .eq('id', idCita)
    .eq('account_id', accountId)
    .maybeSingle()
  if (findErr || !cita) {
    return 'Error: no se encontró la cita indicada.'
  }
  if (cita.estado === 'cancelada') {
    return 'La cita ya estaba cancelada.'
  }

  const cal = calendarClient()
  try {
    await cal.events.delete({
      calendarId: CAL_ID,
      eventId: cita.google_event_id,
    }, { timeout: CALENDAR_TIMEOUT_MS })
  } catch (err) {
    console.error('[calendar] events.delete failed:', err)
    return 'Error: Google Calendar no pudo eliminar la cita.'
  }

  const { error } = await db
    .from('citas')
    .update({ estado: 'cancelada' })
    .eq('id', idCita)
    .eq('account_id', accountId)
  if (error) {
    console.error('[calendar] citas update estado failed:', error)
    return `Error: el evento se eliminó de Google Calendar pero no se pudo actualizar el CRM (${error.message}).`
  }

  return 'Cita cancelada correctamente.'
}

// ------------------------------------------------------------
// Parsing helpers
// ------------------------------------------------------------

function parseWindowBound(value: string, isEnd: boolean): Date {
  const trimmed = value.trim()
  if (!trimmed) {
    return isEnd
      ? new Date(new Date().setHours(23, 59, 59, 0))
      : new Date()
  }
  // A bare date (YYYY-MM-DD) means the whole (Lima) day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    if (isEnd) return new Date(`${trimmed}T23:59:59-05:00`)
    return new Date(`${trimmed}T00:00:00-05:00`)
  }
  const d = new Date(trimmed)
  return Number.isNaN(d.getTime()) ? (isEnd ? new Date() : new Date()) : d
}

/** Validate an appointment start: parseable AND inside business hours. */
function parseAppointmentStart(value: string): Date | null {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null

  const p = limaParts(d)
  const hours = BUSINESS_HOURS[p.weekday]
  if (!hours) return null

  const minuteOfDay = p.hour * 60 + p.minute
  if (minuteOfDay < hours.openMin) return null
  if (minuteOfDay + APPOINTMENT_DURATION_MIN > hours.closeMin) return null

  return d
}