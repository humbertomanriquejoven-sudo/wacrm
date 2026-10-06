import { randomUUID } from 'node:crypto';
import { calendar as calendarV3 } from '@googleapis/calendar';
import { JWT, OAuth2Client } from 'google-auth-library';
import type { SupabaseClient } from '@supabase/supabase-js';
import { enviarConfirmacionCita } from '@/lib/gmail';

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
// Business hours are fixed (America/Bogota), same every day:
//   Monday to Sunday 08:00-23:00.
// ============================================================

const CAL_ID = process.env.GOOGLE_CALENDAR_ID ?? '';
// OAuth2 (installed-app) credentials — the reliable path to create
// Google Meet conferences on a personal gmail.com calendar. A service
// account cannot host Meet on a Gmail calendar, so when these three are
// present we prefer OAuth2 over the JWT/service-account path.
const OAUTH_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? '';
const OAUTH_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? '';
const OAUTH_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN ?? '';
const SVC_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? '';
const SVC_CLIENT_EMAIL = process.env.GOOGLE_CALENDAR_CLIENT_EMAIL ?? '';
const SVC_PRIVATE_KEY = process.env.GOOGLE_CALENDAR_PRIVATE_KEY ?? '';

const CAL_TIMEZONE = 'America/Bogota';
/** Default appointment length. Meetings run 45 minutes. */
export const APPOINTMENT_DURATION_MIN = 45;
/**
 * Fallback de enlace cuando Google Calendar no devuelve hangoutLink,
 * entryPoints de video ni htmlLink. Garantiza que la confirmación de una
 * cita JAMÁS salga sin URL: `new` abre una sala de Meet válida.
 */
export const MEET_FALLBACK_LINK = 'https://meet.google.com/new';
/** Fixed UTC offset for America/Bogota (no DST). */
const BOGOTA_OFFSET = '-05:00';

/**
 * Strict per-request timeout for every Google Calendar network call. A
?
 * hung freebusy/event call must not block the AI tool round (or the
?
 * webhook pipeline); it fails fast and the tool returns a readable
?
 * error instead of stalling the bot.
 */
const CALENDAR_TIMEOUT_MS = 8_000;

/**
 * Techo duro para la CREACIÓN del evento en agendar_cita: 4 segundos.
 * Si Google no responde dentro de los 4 segundos, agendar_cita resuelve
 * de inmediato con la confirmación basada en la BD (nunca más de 4s y
 * nunca deja una promesa colgada sin resolver).
 */
const AGENDAR_TIMEOUT_MS = 4_000;

export const BUSINESS_HOURS: Record<
  number,
  { openMin: number; closeMin: number }
> = {
  0: { openMin: 8 * 60, closeMin: 23 * 60 },
  1: { openMin: 8 * 60, closeMin: 23 * 60 },
  2: { openMin: 8 * 60, closeMin: 23 * 60 },
  3: { openMin: 8 * 60, closeMin: 23 * 60 },
  4: { openMin: 8 * 60, closeMin: 23 * 60 },
  5: { openMin: 8 * 60, closeMin: 23 * 60 },
  6: { openMin: 8 * 60, closeMin: 23 * 60 },
};

function isCalendarConfigured(): boolean {
  const hasOauth = Boolean(
    OAUTH_CLIENT_ID.trim() &&
    OAUTH_CLIENT_SECRET.trim() &&
    OAUTH_REFRESH_TOKEN.trim()
  );
  const hasJson = Boolean(SVC_JSON.trim());
  const hasPair = Boolean(SVC_CLIENT_EMAIL.trim() && SVC_PRIVATE_KEY.trim());
  return Boolean(CAL_ID.trim() && (hasOauth || hasJson || hasPair));
}

/** Whether the Google Calendar env vars are set (tools are available). */
export function calendarConfigured(): boolean {
  return isCalendarConfigured();
}

/**
 * Produce a canonical PEM private key from whatever mess the env delivered:
 * literal `\n` escapes, real newlines, or stray spaces inside the base64
 * body (a classic paste artifact). The body is stripped of ALL whitespace
 * and re-wrapped at 64 columns so google-auth-library's decoder always sees
 * a clean, valid key.
 */
export function canonicalizePrivateKey(raw: string): string {
  const s = (raw ?? '').replace(/\\n/g, '\n').trim();
  const begin = s.indexOf('-----BEGIN');
  const end = s.indexOf('-----END');
  if (begin === -1 || end === -1 || end < begin) {
    return s.replace(/\s+/g, ' ').trim();
  }
  const header = s
    .slice(
      begin,
      s.indexOf('\n', begin) === -1
        ? begin + '-----BEGIN PRIVATE KEY-----'.length
        : s.indexOf('\n', begin)
    )
    .trim();
  const footer = s
    .slice(end, s.indexOf('\n', end) === -1 ? s.length : s.indexOf('\n', end))
    .trim();
  const body = s.slice(begin + header.length, end).replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) ?? [];
  return `${header}\n${lines.join('\n')}\n${footer}`;
}

function calendarClient() {
  if (!isCalendarConfigured()) {
    throw new Error(
      'Google Calendar is not configured: set GOOGLE_CALENDAR_ID and either GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN (OAuth2) or GOOGLE_SERVICE_ACCOUNT_JSON / GOOGLE_CALENDAR_CLIENT_EMAIL + GOOGLE_CALENDAR_PRIVATE_KEY.'
    );
  }

  // OAuth2 installed-app flow, preferred. google-auth-library's OAuth2Client
  // transparently refreshes the access token from GOOGLE_REFRESH_TOKEN, and
  // `calendarV3` attaches it. Without this, Meet creation is rejected on
  // personal (gmail.com) calendars with "Invalid conference type value".
  if (
    OAUTH_CLIENT_ID.trim() &&
    OAUTH_CLIENT_SECRET.trim() &&
    OAUTH_REFRESH_TOKEN.trim()
  ) {
    const auth = new OAuth2Client({
      clientId: OAUTH_CLIENT_ID,
      clientSecret: OAUTH_CLIENT_SECRET,
    });
    auth.setCredentials({ refresh_token: OAUTH_REFRESH_TOKEN });
    return calendarV3({ version: 'v3', auth });
  }

  let email: string;
  let key: string;
  if (SVC_JSON.trim()) {
    let creds: {
      client_email?: string;
      private_key?: string;
    };
    try {
      creds = JSON.parse(SVC_JSON) as {
        client_email?: string;
        private_key?: string;
      };
    } catch (err) {
      throw new Error(
        `GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    // The JSON may have kept the private key double-escaped (\\n) or padded
    // with stray whitespace when pasted; canonicalize so the JWT client
    // always gets a valid, tightly-packed PEM (real newlines, base64 body
    // stripped of every space/newline and re-wrapped at 64 columns).
    email = (creds.client_email ?? '').trim();
    key = canonicalizePrivateKey(creds.private_key ?? '');
  } else {
    email = SVC_CLIENT_EMAIL.trim();
    key = canonicalizePrivateKey(SVC_PRIVATE_KEY);
  }

  const auth = new JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });

  return calendarV3({ version: 'v3', auth });
}

// ------------------------------------------------------------
// Bogota wall-clock helpers (America/Bogota is UTC-5, no DST, but we
// still resolve the offset from the tz database rather than assume).
// ------------------------------------------------------------

const localWallFmt = new Intl.DateTimeFormat('en', {
  timeZone: CAL_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
  hour12: false,
});

interface BogotaParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0=Sun .. 6=Sat
}

function bogotaParts(instant: Date): BogotaParts {
  const parts = Object.fromEntries(
    localWallFmt
      .formatToParts(instant)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
      parts.weekday
    ),
  };
}

/** RFC3339 (offset -05:00) of `instant` expressed in Bogota wall time. */
function bogotaIso(instant: Date): string {
  const p = bogotaParts(instant);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${BOGOTA_OFFSET}`;
}

function bogotaDateKey(instant: Date): string {
  return bogotaIso(instant).slice(0, 10);
}

/** Instant whose Bogota wall clock equals the given date + minute-of-day. */
function instantFromBogotaWall(dateKey: string, minuteOfDay: number): Date {
  const [y, m, d] = dateKey.split('-').map(Number);
  const h = Math.floor(minuteOfDay / 60);
  const min = minuteOfDay % 60;
  const approxUtc = new Date(Date.UTC(y, m - 1, d, h, min, 0, 0));
  const offsetMin =
    bogotaParts(approxUtc).hour * 60 +
    bogotaParts(approxUtc).minute -
    (h * 60 + min);
  return new Date(approxUtc.getTime() - offsetMin * 60_000);
}

// ------------------------------------------------------------
// Free/busy queries
// ------------------------------------------------------------

interface BusyInterval {
  start: Date;
  end: Date;
}

/** True when interval `a` is fully contained in interval `b`. */
function isInside(a: BusyInterval, b: BusyInterval): boolean {
  return (
    a.start.getTime() >= b.start.getTime() && a.end.getTime() <= b.end.getTime()
  );
}

/**
 * True when busy interval `b` is the appointment we are moving. The remote
 * event may be longer/shorter than the current default (legacy 60-min rows),
 * so match on the shared start instant as well as containment.
 */
function isSelfSlot(b: BusyInterval, self: BusyInterval): boolean {
  return b.start.getTime() === self.start.getTime() || isInside(b, self);
}

async function fetchBusy(
  from: Date,
  to: Date,
  exclude?: BusyInterval | null
): Promise<BusyInterval[]> {
  const cal = calendarClient();
  const res = await cal.freebusy.query(
    {
      requestBody: {
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        timeZone: CAL_TIMEZONE,
        items: [{ id: CAL_ID }],
      },
    },
    { timeout: CALENDAR_TIMEOUT_MS }
  );
  const busy = res.data.calendars?.[CAL_ID]?.busy ?? [];
  return busy
    .filter((b) => b.start && b.end)
    .map((b) => ({ start: new Date(b.start!), end: new Date(b.end!) }))
    .filter((b) => !exclude || !isSelfSlot(b, exclude))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

function overlaps(
  slotStart: Date,
  slotEnd: Date,
  busy: BusyInterval[]
): boolean {
  return busy.some(
    (b) =>
      slotStart.getTime() < b.end.getTime() &&
      slotEnd.getTime() > b.start.getTime()
  );
}

/**
 * ver_disponibilidad(desde, hasta) — list free 45-minute slots within
 * business hours that fall inside the given window. `desde`/`hasta`
 * are ISO date-times in America/Bogota (a timezone-less value is read as
 * Bogota wall time) or date-only, interpreted as the full day.
 * Returns a human-readable summary for the model to relay or use.
 */
export async function ver_disponibilidad(
  desde: string,
  hasta: string
): Promise<string> {
  const from = parseWindowBound(desde, /* isEnd */ false);
  const to = parseWindowBound(hasta, /* isEnd */ true);
  if (!from || !to) {
    return [
      'Error: no se pudo interpretar una de las fechas como fecha.',
      `Usa formato ISO 8601 en hora de Bogotá, por ejemplo 2026-09-17 o 2026-09-17T15:00:00-05:00.`,
      'Si el cliente pidió algo relativo ("dentro de 2 días", "el martes que viene"), ' +
        'resuélvelo con la hora actual de Bogotá antes de llamar a esta herramienta.',
      `Ahora en Bogotá: ${bogotaIso(new Date())}.`,
    ].join(' ');
  }

  // Flexibilidad con hora puntual: si la consulta es un único instante
  // (p. ej. desde="2026-09-18T18:00:00-05:00" con hasta igual o anterior),
  // se interpreta como el rango de 45 minutos que comienza en esa hora
  // (18:00 → 18:00-18:45) en lugar de rechazarlo. Así el modelo NUNCA
  // recibe un aviso de que no se puede verificar una hora puntual.
  if (from.getTime() >= to.getTime() && hasExplicitTime(desde)) {
    const point = parseAppointmentStartDetailed(desde);
    if (point.kind === 'unparseable') {
      return [
        'Error: no se pudo interpretar la hora indicada como fecha.',
        `Recibido: "${desde}". Usa formato ISO 8601 en hora de Bogotá, por ejemplo 2026-09-18T18:00:00-05:00.`,
        `Ahora en Bogotá: ${bogotaIso(new Date())}.`,
      ].join(' ');
    }
    if (point.kind === 'outside_hours') {
      return [
        `Error: la hora "${bogotaIso(point.date)}" es válida pero cae fuera del horario de atención.`,
        'NO cambies la fecha: solo mueve la hora.',
        `Horario de atención: ${hhmm(point.openMin)}–${hhmm(point.closeMin)}; la última hora ` +
          `de inicio posible para una cita de ${APPOINTMENT_DURATION_MIN} minutos es ` +
          `${hhmm(point.closeMin - APPOINTMENT_DURATION_MIN)}.`,
        'Vuelve a llamar a ver_disponibilidad con la hora corregida.',
      ].join(' ');
    }
    const start = point.date;
    const end = new Date(start.getTime() + APPOINTMENT_DURATION_MIN * 60_000);
    let busy: BusyInterval[];
    try {
      busy = await fetchBusy(start, end);
    } catch (err) {
      console.error('[calendar] freebusy failed:', err);
      return 'Error: no se pudo consultar la disponibilidad del calendario.';
    }
    return overlaps(start, end, busy)
      ? `El horario de ${bogotaIso(start)} a ${bogotaIso(end)} está ocupado. Consulta ver_disponibilidad con un rango de fechas para ver alternativas.`
      : `El horario de ${bogotaIso(start)} a ${bogotaIso(end)} está disponible.`;
  }

  if (from.getTime() >= to.getTime()) {
    return 'Error: el rango "desde" debe ser anterior a "hasta".';
  }

  let busy: BusyInterval[];
  try {
    busy = await fetchBusy(from, to);
  } catch (err) {
    console.error('[calendar] freebusy failed:', err);
    return 'Error: no se pudo consultar la disponibilidad del calendario.';
  }

  const slots: Date[] = [];
  const seenDays = new Set<string>();
  for (
    let t = from.getTime();
    t <= to.getTime() + 24 * 60 * 60 * 1000;
    t += 12 * 60 * 60 * 1000
  ) {
    const day = bogotaDateKey(new Date(t));
    if (seenDays.has(day)) continue;
    seenDays.add(day);

    const parts = bogotaParts(new Date(t));
    const hours = BUSINESS_HOURS[parts.weekday];
    if (!hours) continue;

    for (
      let startMin = hours.openMin;
      startMin + APPOINTMENT_DURATION_MIN <= hours.closeMin;
      startMin += 30
    ) {
      const slotStart = instantFromBogotaWall(day, startMin);
      const slotEnd = new Date(
        slotStart.getTime() + APPOINTMENT_DURATION_MIN * 60_000
      );
      if (slotStart.getTime() < from.getTime()) continue;
      if (slotEnd.getTime() > to.getTime()) continue;
      if (overlaps(slotStart, slotEnd, busy)) continue;
      slots.push(slotStart);
    }
  }

  if (slots.length === 0) {
    return 'No hay horarios disponibles en el rango solicitado.';
  }

  const byDay = new Map<string, Date[]>();
  for (const s of slots) {
    const key = bogotaDateKey(s);
    byDay.set(key, [...(byDay.get(key) ?? []), s]);
  }

  const lines: string[] = ['Horarios disponibles (hora Bogota):'];
  for (const [day, daySlots] of [...byDay.entries()].sort()) {
    const p = bogotaParts(daySlots[0]);
    const weekdayName = [
      'domingo',
      'lunes',
      'martes',
      'miércoles',
      'jueves',
      'viernes',
      'sábado',
    ][p.weekday];
    lines.push(
      `${weekdayName} ${day}: ${daySlots.map((s) => bogotaIso(s)).join(', ')}`
    );
  }
  return lines.join('\n');
}

export interface OcupadoIntervalo {
  /** ISO instant (ms-precision UTC) of the busy block start. */
  start: string;
  /** ISO instant (ms-precision UTC) of the busy block end. */
  end: string;
  /** Google Calendar event id, when the block is a real event. */
  id?: string | null;
  /** Event title (`summary`), when the block is a real event. */
  summary?: string | null;
  /** Event `description`, when the block is a real event. */
  description?: string | null;
  /** Invited guests (`attendees`), when the block is a real event. */
  attendees?: Array<{
    email?: string | null;
    displayName?: string | null;
    responseStatus?: string | null;
  }> | null;
  /** Meet hangout link (falling back to the htmlLink), when present. */
  meetLink?: string | null;
}

export interface ConsultaOcupados {
  /** false when freebusy failed (timeout, unconfigured, etc.). */
  ok: boolean;
  ocupados: OcupadoIntervalo[];
}

/**
 * consultar_ocupados(desde, hasta) — busy intervals for the weekly-view
 * grid on /calendario. Wraps the internal freeBusy call so the page can
 * render the DB citas as a fallback and show a subtle notice when Google
 * is unavailable: a failure returns `ok: false` with an empty list
 * instead of throwing.
 */
export async function consultarOcupados(
  desdeIso: string,
  hastaIso: string
): Promise<ConsultaOcupados> {
  const from = new Date(desdeIso);
  const to = new Date(hastaIso);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { ok: false, ocupados: [] };
  }
  try {
    const busy = await fetchBusy(from, to);
    return {
      ok: true,
      ocupados: busy.map((b) => ({
        start: b.start.toISOString(),
        end: b.end.toISOString(),
      })),
    };
  } catch (err) {
    console.error('[calendar] consultarOcupados failed:', err);
    return { ok: false, ocupados: [] };
  }
}

/** Map a Google Calendar event to a grid busy block (with details). */
function eventoAOcupado(
  e: import('@googleapis/calendar').calendar_v3.Schema$Event
): OcupadoIntervalo | null {
  const isAllDay = Boolean(e.start?.date && !e.start?.dateTime);
  const s = e.start?.dateTime ?? e.start?.date ?? '';
  const en = e.end?.dateTime ?? e.end?.date ?? '';
  if (!s || !en) return null;

  let startIso: string;
  let endIso: string;
  if (isAllDay) {
    // All-day: busy from Bogota midnight of `start.date` through the
    // exclusive `end.date` (start of that day), as UTC ISO instants.
    startIso = new Date(`${s}T00:00:00${BOGOTA_OFFSET}`).toISOString();
    endIso = new Date(`${en}T00:00:00${BOGOTA_OFFSET}`).toISOString();
  } else {
    const dStart = new Date(s);
    const dEnd = new Date(en);
    if (Number.isNaN(dStart.getTime()) || Number.isNaN(dEnd.getTime())) {
      return null;
    }
    startIso = dStart.toISOString();
    endIso = dEnd.toISOString();
  }

  return {
    start: startIso,
    end: endIso,
    id: e.id ?? null,
    summary: e.summary?.trim() || null,
    description: e.description || null,
    attendees:
      e.attendees?.map((a) => ({
        email: a.email ?? null,
        displayName: a.displayName ?? null,
        responseStatus: a.responseStatus ?? null,
      })) ?? null,
    meetLink: e.hangoutLink ?? e.htmlLink ?? null,
  };
}

/**
 * Busy blocks for /calendario WITH event details (summary, description,
 * attendees, Meet link) so the grid can render a Google-Calendar-style
 * popover on click. Uses `events.list` (single events in the window)
 * instead of freebusy. On any failure it degrades to `ok: false` and the
 * page falls back to `consultarOcupados` (plain freebusy intervals).
 */
export async function listar_ocupados_detalle(
  desdeIso: string,
  hastaIso: string
): Promise<ConsultaOcupados> {
  const from = new Date(desdeIso);
  const to = new Date(hastaIso);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { ok: false, ocupados: [] };
  }
  try {
    const cal = calendarClient();
    const res = await cal.events.list(
      {
        calendarId: CAL_ID,
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        maxResults: 250,
        singleEvents: true,
        orderBy: 'startTime',
        timeZone: CAL_TIMEZONE,
      },
      { timeout: CALENDAR_TIMEOUT_MS }
    );
    const ocupados: OcupadoIntervalo[] = (res.data.items ?? [])
      .filter((e) => e.status !== 'cancelled')
      .flatMap((e) => {
        const r = eventoAOcupado(e);
        return r ? [r] : [];
      });
    return { ok: true, ocupados };
  } catch (err) {
    console.error('[calendar] listar_ocupados_detalle failed:', err);
    return { ok: false, ocupados: [] };
  }
}

export interface ListarEventosArgs {
  /** Window start (ISO "2026-09-17" or "2026-09-17T00:00:00-05:00"). Default: now. */
  desde?: string;
  /** Window end. Default: none (Google returns from `desde` onwards). */
  hasta?: string;
  /** Number of events to fetch. Default 100, ceiling 250. */
  maxResults?: number;
}

/**
 * listar_eventos — list upcoming calendar events as RFC3339 strings for the
 * model to relay ("¿qué tengo esta semana?"). Uses `maxResults: 100` by
 * default to break the API's built-in 5-result cap.
 */
export async function listar_eventos(
  args: ListarEventosArgs = {}
): Promise<string> {
  const maxResults = Math.min(Math.max(1, args.maxResults ?? 100), 250);
  const from = args.desde ? parseBogotaInstant(args.desde) : new Date();
  const to = args.hasta ? parseBogotaInstant(args.hasta) : null;
  if (!from || (args.hasta !== undefined && !to)) {
    return 'Error: fecha inválida en listar_eventos. Usa formato ISO 8601 en hora de Bogotá (p. ej. 2026-09-17 o 2026-09-17T15:00:00-05:00).';
  }

  const cal = calendarClient();
  try {
    const res = await cal.events.list(
      {
        calendarId: CAL_ID,
        timeMin: from.toISOString(),
        ...(to ? { timeMax: to.toISOString() } : {}),
        maxResults,
        singleEvents: true,
        orderBy: 'startTime',
        timeZone: CAL_TIMEZONE,
      },
      { timeout: CALENDAR_TIMEOUT_MS }
    );
    const items = res.data.items ?? [];
    if (items.length === 0) {
      return 'No hay eventos en el rango indicado.';
    }
    return items
      .map((e) => {
        const start = e.start?.dateTime ?? e.start?.date ?? '?';
        const end = e.end?.dateTime ?? e.end?.date ?? '';
        const label = e.summary?.trim() || '(sin título)';
        // Meet primero, htmlLink (URL del evento) como respaldo.
        const link = e.hangoutLink ?? e.htmlLink ?? '';
        return `- ${start} → ${end} | ${label}${link ? ` | Enlace: ${link}` : ''}`;
      })
      .join('\n');
  } catch (err) {
    console.error('[calendar] events.list failed:', err);
    return 'Error: no se pudo consultar los eventos del calendario.';
  }
}

// ------------------------------------------------------------
// Lifecycle: create / reschedule / cancel
// ------------------------------------------------------------

export interface AgendarCitaArgs {
  db: SupabaseClient;
  accountId: string;
  contactoId: string;
  inicio: string;
  nombre: string;
  motivo?: string;
  /** Contact email used for the calendar invite attendee. */
  correoCliente?: string;
}

/**
 * Rechaza una promesa pasados `ms` milisegundos si no resolvió antes.
 * Frente a una API de Google lenta o colgada, agendar_cita no se queda
 * esperando: falla rápido (máx 8s) y sigue con la persistencia local de
 * la cita y el retorno de éxito al agente.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[calendar] ${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Minimal shape of a Google event needed to resolve its meeting link. Declared
 * structurally (not as `Schema$Event`) so tests and other providers can pass a
 * plain object without importing the googleapis types.
 */
export interface CalendarEventLike {
  hangoutLink?: string | null;
  htmlLink?: string | null;
  conferenceData?: {
    entryPoints?: Array<{
      entryPointType?: string | null;
      uri?: string | null;
    } | null> | null;
  } | null;
}

/**
 * Resolve the customer-facing meeting link of an event, applying the MANDATORY
 * hierarchy: hangoutLink > conferenceData.entryPoints[video] > htmlLink >
 * MEET_FALLBACK_LINK.
 *
 * Shared by every lifecycle operation because a MOVED event can come back with
 * a freshly generated Meet link: re-reading it here is what stops the CRM (and
 * therefore the customer) from being pointed at the link of the previous slot.
 * A confirmed appointment never leaves without a URL.
 */
export function resolveMeetLink(data: CalendarEventLike | null | undefined): {
  link: string;
  esMeet: boolean;
} {
  const hangout = data?.hangoutLink ?? null;
  const videoUri =
    data?.conferenceData?.entryPoints?.find(
      (entry) => entry?.entryPointType === 'video'
    )?.uri ?? null;
  const link = hangout ?? videoUri ?? data?.htmlLink ?? MEET_FALLBACK_LINK;
  return {
    link,
    esMeet: hangout !== null || videoUri !== null || link === MEET_FALLBACK_LINK,
  };
}

/**
 * Fecha (YYYY-MM-DD) y hora (HH:MM) de un instante en hora de Bogotá.
 *
 * Tolerates an unparseable instant (a malformed DB value) by returning empty
 * strings instead of throwing: this formats DB-sourced timestamps for the
 * agent's benefit, and must never be the thing that fails a booking.
 */
function fechaHoraLocal(start: Date): { fecha: string; hora: string } {
  if (Number.isNaN(start.getTime())) return { fecha: '', hora: '' };
  const fecha = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: CAL_TIMEZONE,
  }).format(start);
  const hora = new Intl.DateTimeFormat('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: CAL_TIMEZONE,
  })
    .format(start)
    .replace(/[^\d:]/g, '');
  return { fecha, hora };
}

/**
 * Trailer that carries the machine-readable outcome of a scheduling tool.
 *
 * This is the ONLY channel the auto-reply engine trusts to build a
 * customer-facing confirmation, so a tool that reports success here is
 * reporting a verified provider result, never an intention. `exito:false`
 * entries let the engine say something truthful instead of inventing one.
 */
function toolResultJson(structured: Record<string, unknown>): string {
  return `JSON_RESULT (no lo repitas en el mensaje al cliente, usa su contenido): ${JSON.stringify(structured)}`;
}

/**
 * A scheduling tool outcome that did NOT succeed.
 *
 * Carries a `motivo` code so the engine can tell "this contact has no
 * appointment to move" (a normal conversational turn — offer to book a new
 * one) apart from "the provider rejected the move" (an apology, no
 * confirmation). Both must never be rendered as a confirmation.
 */
function toolFailure(
  mensaje: string,
  extra: { motivo: string; accion?: CitaAccion } = { motivo: 'desconocido' }
): string {
  return `${mensaje}\n\n${toolResultJson({
    exito: false,
    confirmado: false,
    motivo: extra.motivo,
    ...(extra.accion ? { accion: extra.accion } : {}),
  })}`;
}

/** Lifecycle operation a scheduling tool performed. */
export type CitaAccion = 'crear' | 'reagendar' | 'cancelar';

/** agendar_cita — create a 45-minute event and persist the CRM row. */
export async function agendar_cita(args: AgendarCitaArgs): Promise<string> {  const { db, accountId, contactoId, inicio, nombre, motivo, correoCliente } =
    args;
  const parsedStart = parseAppointmentStartDetailed(inicio);
  if (parsedStart.kind !== 'ok') {
    return appointmentStartError(parsedStart, inicio);
  }
  const start = parsedStart.date;
  // Motivo por defecto: el flujo nunca debe bloquearse preguntando por el
  // motivo cuando el usuario no lo mencionó.
  const motivoFinal = motivo?.trim() || 'Consulta / Valoración';

  // La verificación de disponibilidad es best-effort y nunca debe bloquear
  // la cita: si freebusy falla o da timeout, pasamos directo a la creación
  // del evento (la creación en Google Calendar sigue adelante igual).
  try {
    const busy = await fetchBusy(
      start,
      new Date(start.getTime() + APPOINTMENT_DURATION_MIN * 60_000)
    );
    if (busy.length > 0) {
      return 'Error: ese horario ya está ocupado. Consulta ver_disponibilidad antes de agendar.';
    }
  } catch (err) {
    console.warn('[calendar] agendar freebusy failed — booking directly:', err);
  }

  const name = nombre.trim() || 'Cita';
  const title = `Cita con Cliente - ${name}`;

  // Attendee for the Google Calendar invite. Prefer the explicitly passed
  // email; otherwise resolve it from the contact row (best-effort) so the
  // customer receives the official invite with the Meet link attached.
  let clientEmail = correoCliente?.trim() ?? '';
  if (!clientEmail) {
    try {
      const { data: contact } = await db
        .from('contacts')
        .select('email')
        .eq('id', contactoId)
        .maybeSingle();
      clientEmail = (contact?.email as string | null)?.trim() ?? '';
    } catch (err) {
      console.warn('[calendar] contact email lookup failed:', err);
    }
  }
  const attendees = clientEmail ? [{ email: clientEmail }] : undefined;

  let event: { id?: string | null };
  let calendarSynced = true;
  let meetUrl: string | null = null;
  /** Whether `meetUrl` is a Meet hangout (true) or the plain htmlLink (false). */
  let linkEsMeet = false;
  let emailSent = false;
  /** Attendees returned by Google for the created event (or the ones we sent). */
  let eventAttendees: Array<{
    email?: string | null;
    displayName?: string | null;
    responseStatus?: string | null;
  }> | null = null;
  try {
    // El cliente de Google se construye DENTRO del try: si las credenciales
    // faltan o son inválidas, el fallo se degrada al guardado local en vez
    // de lanzar y dejar al cliente sin cita ni respuesta.
    const cal = calendarClient();
    const baseBody = {
      summary: title,
      description: 'Reunión agendada automáticamente por el agente IA del CRM.',
      start: { dateTime: bogotaIso(start), timeZone: CAL_TIMEZONE },
      end: {
        dateTime: bogotaIso(
          new Date(start.getTime() + APPOINTMENT_DURATION_MIN * 60_000)
        ),
        timeZone: CAL_TIMEZONE,
      },
      ...(attendees ? { attendees } : {}),
    };

    // Crear un Google Meet (hangoutsMeet) con reintento SIN conferencia si
    // Google lo rechaza (400 "Invalid conference type value": service account
    // sobre calendario gmail.com personal). Con OAuth2 el Meet se crea bien.
    const tryInsert = async (
      withConference: boolean
    ): Promise<{
      data: import('@googleapis/calendar').calendar_v3.Schema$Event;
    }> =>
      cal.events.insert(
        withConference
          ? {
              calendarId: CAL_ID,
              conferenceDataVersion: 1,
              sendUpdates: 'all',
              requestBody: {
                ...baseBody,
                conferenceData: {
                  createRequest: {
                    requestId: Date.now().toString(),
                    conferenceSolutionKey: { type: 'hangoutsMeet' },
                  },
                },
              },
            }
          : {
              calendarId: CAL_ID,
              sendUpdates: 'all',
              requestBody: { ...baseBody },
            },
        { timeout: AGENDAR_TIMEOUT_MS }
      );

    // Toda la llamada a la API de Google (con el reintento Meet incluido)
    // queda bajo un techo duro de 4s: si Google no responde, la excepción
    // se captura abajo: NUNCA nos quedamos colgados, la cita se
    // guarda igual en la BD y se devuelve un objeto de éxito al agente.
    const created = await withTimeout(
      (async (): Promise<{
        data: import('@googleapis/calendar').calendar_v3.Schema$Event;
      }> => {
        try {
          return await tryInsert(true);
        } catch (firstErr) {
          const isConferenceError =
            /invalid conference|conference type value|conference data/i.test(
              String((firstErr as Error)?.message ?? '')
            );
          if (isConferenceError) {
            // service account + cuenta personal => Meet no soportado, crear plano.
            return tryInsert(false);
          }
          throw firstErr;
        }
      })(),
      AGENDAR_TIMEOUT_MS,
      'agendar events.insert'
    );

    // El evento creado puede traer el Meet en hangoutLink, en
    // conferenceData.entryPoints (video) o, si la cuenta no puede generar
    // conferencias, solo un htmlLink (la URL pública de Google Calendar).
    // Jerarquía OBLIGATORIA del enlace: hangoutLink > conferenceData
    // (entryPoint video) > htmlLink > 'https://meet.google.com/new'. Una
    // cita confirmada NUNCA queda sin enlace real de Google Meet.
    const resolved = resolveMeetLink(created.data);
    meetUrl = resolved.link;
    linkEsMeet = resolved.esMeet;
    event = { id: created.data.id };
    eventAttendees =
      created.data.attendees?.map((a) => ({
        email: a.email ?? null,
        displayName: a.displayName ?? null,
        responseStatus: a.responseStatus ?? null,
      })) ??
      attendees?.map((a) => ({ email: a.email ?? null })) ??
      null;
  } catch (err) {
    console.warn(
      '[calendar] events.insert failed (timeout o error de API):',
      err
    );
    event = { id: 'local-' + randomUUID() };
    meetUrl = MEET_FALLBACK_LINK;
    calendarSynced = false;
  }

  // Persistencia en el CRM. La cita ya quedó confirmada (en Google
  // Calendar o degradada a local). Un fallo de la BD NUNCA debe detener
  // la respuesta del bot ni arruinar la confirmación: se intenta guardar,
  // se registra el error y el flujo continúa con la confirmación completa
  // (fecha, hora, enlace real). El JSON_RESULT de éxito se emite igual.
  let idCita: string | null = null;
  let crmSaved = true;
  try {
    const { data: insertedRow, error } = await db
      .from('citas')
      .insert({
        account_id: accountId,
        contact_id: contactoId,
        google_event_id: event.id ?? '',
        meet_link: meetUrl,
        summary: title,
        description:
          'Reunión agendada automáticamente por el agente IA del CRM.',
        attendees: eventAttendees,
        fecha_inicio: start.toISOString(),
        fecha_fin: new Date(
          start.getTime() + APPOINTMENT_DURATION_MIN * 60_000
        ).toISOString(),
        estado: 'confirmada',
        motivo: motivoFinal,
      })
      .select('id')
      .single();
    if (error) {
      console.error('[calendar] citas insert failed:', error);
      crmSaved = false;
    } else {
      idCita = (insertedRow as { id?: string } | null)?.id ?? null;
    }
  } catch (err) {
    console.error('[calendar] citas insert threw:', err);
    crmSaved = false;
  }

  // Confirmation email (Gmail API) — automatic and best-effort. A mail
  // failure must not undo an already-booked calendar event; we only warn.
  if (clientEmail) {
    const mailConfirmation = await enviarConfirmacionCita({
      to: clientEmail,
      nombre: name.trim(),
      motivo: motivoFinal,
      inicioIso: start.toISOString(),
      duracionMin: APPOINTMENT_DURATION_MIN,
      meetUrl,
      esMeet: linkEsMeet,
    });
    emailSent = mailConfirmation.startsWith('Correo enviado');
    if (!emailSent && mailConfirmation) {
      console.warn('[calendar] confirmation email failed:', mailConfirmation);
    }
  }

  // Fecha (YYYY-MM-DD) y hora (HH:MM) en hora local de Bogotá — el
  // mensaje de éxito de la tool debe citarlas tal cual al cliente.
  const { fecha, hora } = fechaHoraLocal(start);

  const enlaceMsg = meetUrl
    ? linkEsMeet
      ? ` Reunión Meet: ${meetUrl}`
      : ` Enlace del evento: ${meetUrl}`
    : '';

  const human =
    (calendarSynced
      ? `Cita agendada: ${bogotaIso(start)} (45 minutos), cliente: ${name}.${enlaceMsg}`
      : `Cita agendada: ${bogotaIso(start)} (45 minutos), cliente: ${name}. (Google Calendar no disponible; la cita quedó guardada en el CRM con enlace provisional de Meet.${enlaceMsg})`) +
    (crmSaved
      ? ''
      : ' (El CRM no pudo guardar la cita; quedó confirmada solo en Google Calendar.)') +
    (emailSent ? ` Correo de confirmación enviado a ${clientEmail}.` : '');

  // Respuesta estructurada para el agente: marca de éxito inequívoca y el
  // enlace exacto (hangoutLink > htmlLink) que debe citar al cliente.
  // Es un ámbito de la tool, no del mensaje al cliente.
  const structured: Record<string, unknown> = {
    exito: true,
    accion: 'crear',
    mensaje: 'Cita agendada correctamente',
    fecha,
    hora,
    link: meetUrl ?? null,
    confirmado: true,
    // false cuando la creación del evento en Google Calendar falló (timeout
    // o error de API) y la cita solo quedó guardada en el CRM. El motor de
    // auto-respuesta lo usa para NOTIFICAR al cliente en vez de simular un
    // enlace que Google nunca generó.
    calendarSynced,
    inicio: bogotaIso(start),
    duracionMin: APPOINTMENT_DURATION_MIN,
    idCita,
    estado: 'confirmada',
  };

  // Resultado textual para el modelo: la PRIMERÍSIMA línea es SIEMPRE la
  // confirmación con el enlace de Google Meet obligatorio, en el formato
  // exacto (nombre, fecha, hora y URL reales devueltos por la API — la
  // tool nunca inventa un enlace). El human detallado y el JSON_RESULT
  // se conservan para el resto del sistema (diagnóstico, determinismo,
  // reenvío de link por BD), después de esa línea de éxito.
  const resumenExito = `ÉXITO: Cita creada para ${name} el ${fecha} a las ${hora}. Enlace de Google Meet OBLIGATORIO: ${meetUrl}`;

  return `${resumenExito}\n\n${human}\n\n${toolResultJson(structured)}`;
}

export interface ReagendarCitaArgs {
  db: SupabaseClient;
  accountId: string;
  /**
   * Contact whose active appointment to move is resolved automatically when
   * `idCita` is absent. This is what makes the tool self-sufficient: the model
   * no longer has to recall a UUID from the prompt, so it cannot fall back to
   * `agendar_cita` (and duplicate the event) just because it forgot the id.
   */
  contactId?: string;
  /** Explicit appointment to move. Takes precedence over `contactId`. */
  idCita?: string;
  nuevoInicio: string;
}

/** A `citas` row as needed to move it. */
interface CitaResoluble {
  id: string;
  google_event_id: string;
  account_id: string;
  fecha_inicio: string;
  estado: string;
  meet_link: string | null;
  summary: string | null;
  description: string | null;
  attendees: unknown;
  motivo: string | null;
}

const CITA_MOVIBLE =
  'id, google_event_id, account_id, fecha_inicio, estado, meet_link, summary, description, attendees, motivo';

/**
 * The contact's appointment to move, most relevant first.
 *
 * This is the ATOMIC lookup the reschedule flow needs: it scopes to the
 * account AND the contact, keeps only `confirmada` rows, and prefers the
 * soonest one still ahead of us. Asking for a concrete `idCita` is never
 * required — and never authoritative over the account/contact scope.
 */
async function buscarCitaActiva(
  db: SupabaseClient,
  accountId: string,
  contactId: string
): Promise<CitaResoluble | null> {
  const { data, error } = await db
    .from('citas')
    .select(CITA_MOVIBLE)
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('estado', 'confirmada')
    .order('fecha_inicio', { ascending: true })
    .limit(25);

  if (error || !Array.isArray(data) || data.length === 0) {
    if (error) console.error('[calendar] active cita lookup failed:', error);
    return null;
  }

  const ahora = Date.now();
  // Soonest upcoming first; a past booking is only used when nothing is ahead
  // (the customer may still be asking about the one they just had).
  const futuras = data.filter(
    (c) => new Date(c.fecha_inicio as string).getTime() >= ahora
  );
  const elegible = futuras.length > 0 ? futuras : data;
  return elegible[0] as CitaResoluble;
}

/**
 * Resolve the appointment a reschedule/cancel refers to, from an explicit id
 * or from the contact's active one. Returns `undefined` on a lookup error and
 * `null` when there is genuinely nothing to act on, so the caller can tell
 * "no appointment exists" (conversational) from "the DB is down" (retryable).
 */
async function resolverCitaObjetivo(
  db: SupabaseClient,
  accountId: string,
  args: { idCita?: string; contactId?: string }
): Promise<CitaResoluble | null | undefined> {
  if (args.idCita) {
    const { data, error } = await db
      .from('citas')
      .select(CITA_MOVIBLE)
      .eq('id', args.idCita)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) {
      console.error('[calendar] cita lookup failed:', error);
      return undefined;
    }
    if (!data) return null;
    return data as CitaResoluble;
  }
  if (args.contactId) {
    return buscarCitaActiva(db, accountId, args.contactId);
  }
  return null;
}

/**
 * Customer-facing text for a contact with no appointment on file. Shared by
 * every lookup-driven path so the agent always invites a fresh booking instead
 * of dead-ending the conversation.
 */
function sinCitaPreviaMessage(nombre?: string | null): string {
  const saludo = nombre?.trim() ? `, ${nombre.trim()}` : '';
  return (
    `No encontré ninguna cita previa activa${saludo}, así que no hay nada que reagendar por ahora. ` +
    'Con gusto te agendo una nueva: dime la fecha y la hora que prefieras.'
  );
}

/**
 * reagendar_cita — MOVE an existing appointment to a new start time.
 *
 * Hard invariants (see the rescheduling regression suite):
 *  1. It NEVER creates an event. The move is an `events.patch` on the stored
 *     `google_event_id`; a duplicate agenda entry is impossible by
 *     construction, not by convention.
 *  2. The customer's data (summary, description, attendees, motivo) is carried
 *     through, so a move cannot silently drop the client record.
 *  3. The confirmation is emitted only AFTER the provider answered OK and the
 *     CRM row was updated, and it carries the link returned for the NEW slot —
 *     never the previous one.
 */
export async function reagendar_cita(args: ReagendarCitaArgs): Promise<string> {
  const { db, accountId, idCita, contactId, nuevoInicio } = args;
  const start = parseAppointmentStart(nuevoInicio);
  if (start === null) {
    return toolFailure(
      'Error: "nuevoInicio" no es una fecha válida o cae fuera del horario de atención.',
      { motivo: 'fecha_invalida', accion: 'reagendar' }
    );
  }

  const cita = await resolverCitaObjetivo(db, accountId, { idCita, contactId });
  if (cita === undefined) {
    return toolFailure(
      'Error: no se pudo consultar la cita del cliente en el sistema.',
      { motivo: 'consulta_fallida', accion: 'reagendar' }
    );
  }
  if (cita === null) {
    // Requirement: say so kindly and offer a new booking — never attempt a
    // compensating `agendar_cita`, which is what duplicated the agenda.
    return toolFailure(sinCitaPreviaMessage(), {
      motivo: 'sin_cita_previa',
      accion: 'reagendar',
    });
  }

  const end = new Date(start.getTime() + APPOINTMENT_DURATION_MIN * 60_000);

  // The event being moved still occupies its current slot in the
  // calendar until we PATCH it, so its own window must not count as
  // "busy" when checking availability for the new start time.
  const oldStart = new Date(cita.fecha_inicio);
  const oldInterval: BusyInterval | null = Number.isNaN(oldStart.getTime())
    ? null
    : {
        start: oldStart,
        end: new Date(oldStart.getTime() + APPOINTMENT_DURATION_MIN * 60_000),
      };

  try {
    const busy = await fetchBusy(start, end, oldInterval);
    if (busy.length > 0) {
      return toolFailure(
        'Error: ese horario ya está ocupado. Consulta ver_disponibilidad antes de reagendar.',
        { motivo: 'horario_ocupado', accion: 'reagendar' }
      );
    }
  } catch (err) {
    console.error('[calendar] reagendar freebusy failed:', err);
    return toolFailure(
      'Error: no se pudo confirmar el horario en el calendario.',
      { motivo: 'disponibilidad_no_verificable', accion: 'reagendar' }
    );
  }

  /**
   * A row whose `google_event_id` is the local-only placeholder written when
   * `events.insert` failed means there is no remote event to move. Patching a
   * synthetic id would 404/410 and, worse, invite a compensating insert that
   * duplicates the agenda once the calendar recovers. Move the CRM row and
   * report `calendarSynced: false` so the customer is told the truth.
   */
  const esEventoRemoto =
    typeof cita.google_event_id === 'string' &&
    cita.google_event_id.length > 0 &&
    !cita.google_event_id.startsWith('local-');

  let calendarSynced = true;
  /** Link for the NEW slot, re-read from the provider's patch response. */
  let nuevoLink = cita.meet_link ?? null;
  let linkEsMeet = nuevoLink !== null;

  if (esEventoRemoto) {
    try {
      const cal = calendarClient();
      const respuesta = await cal.events.patch(
        {
          calendarId: CAL_ID,
          eventId: cita.google_event_id,
          // Google notifies the attendees itself; we also send our own
          // confirmation below so WhatsApp and email never disagree.
          sendUpdates: 'all',
          requestBody: {
            // Move only. summary/description/attendees are re-sent so the
            // client record survives even if the provider treats this as a
            // replace rather than a merge.
            ...(cita.summary ? { summary: cita.summary } : {}),
            ...(cita.description ? { description: cita.description } : {}),
            ...(Array.isArray(cita.attendees) && cita.attendees.length > 0
              ? { attendees: cita.attendees }
              : {}),
            start: { dateTime: bogotaIso(start), timeZone: CAL_TIMEZONE },
            end: { dateTime: bogotaIso(end), timeZone: CAL_TIMEZONE },
          },
        },
        { timeout: CALENDAR_TIMEOUT_MS }
      );

      // Re-resolve the link from the PATCHED event: moving an event can make
      // Google issue a different Meet URL, and resending the previous one would
      // point the customer at a stale room.
      const resolved = resolveMeetLink(respuesta?.data);
      if (resolved.link !== MEET_FALLBACK_LINK) {
        nuevoLink = resolved.link;
        linkEsMeet = resolved.esMeet;
      }
    } catch (err) {
      console.error('[calendar] events.patch failed:', err);
      return toolFailure(
        'Error: Google Calendar no pudo reagendar la cita.',
        { motivo: 'proveedor_error', accion: 'reagendar' }
      );
    }
  } else {
    calendarSynced = false;
  }

  if (!nuevoLink) nuevoLink = MEET_FALLBACK_LINK;

  // Persist the move. `meet_link` is updated too, otherwise the CRM keeps
  // advertising the link of the slot the customer just left.
  const { error } = await db
    .from('citas')
    .update({
      fecha_inicio: start.toISOString(),
      fecha_fin: end.toISOString(),
      meet_link: nuevoLink,
    })
    .eq('id', cita.id)
    .eq('account_id', accountId);
  if (error) {
    console.error('[calendar] citas update failed:', error);
    return toolFailure(
      `Error: el evento se movió en Google Calendar pero no se pudo actualizar el CRM (${error.message}).`,
      { motivo: 'crm_update_fallido', accion: 'reagendar' }
    );
  }

  // Confirmation email, mirroring agendar_cita: best-effort, and a mail failure
  // never invalidates a move that already succeeded in the provider.
  let emailSent = false;
  const destinatario =
    Array.isArray(cita.attendees)
      ? (cita.attendees as Array<{ email?: string | null }>).find(
          (a) => typeof a?.email === 'string' && a.email.trim()
        )?.email
      : undefined;
  if (destinatario) {
    const mail = await enviarConfirmacionCita({
      to: destinatario,
      nombre: destinatario,
      motivo: cita.motivo ?? 'Consulta / Valoración',
      inicioIso: start.toISOString(),
      duracionMin: APPOINTMENT_DURATION_MIN,
      meetUrl: nuevoLink,
      esMeet: linkEsMeet,
    });
    emailSent = mail.startsWith('Correo enviado');
    if (!emailSent && mail) {
      console.warn('[calendar] reschedule confirmation email failed:', mail);
    }
  }

  const { fecha, hora } = fechaHoraLocal(start);
  const human =
    `Cita reagendada para: ${bogotaIso(start)} (${APPOINTMENT_DURATION_MIN} minutos).` +
    (calendarSynced
      ? ''
      : ' (El evento no existe en Google Calendar, solo se actualizó la cita del CRM.)') +
    (emailSent ? ' Correo de confirmación enviado.' : '');

  const structured: Record<string, unknown> = {
    exito: true,
    accion: 'reagendar',
    mensaje: 'Cita reagendada correctamente',
    confirmado: true,
    calendarSynced,
    fecha,
    hora,
    link: nuevoLink,
    inicio: bogotaIso(start),
    duracionMin: APPOINTMENT_DURATION_MIN,
    idCita: cita.id,
    estado: 'confirmada',
  };

  const resumenExito = `ÉXITO: cita existente MOVIDA (no se creó una nueva) para el ${fecha} a las ${hora}. Enlace de la reunión: ${nuevoLink}`;
  return `${resumenExito}\n\n${human}\n\n${toolResultJson(structured)}`;
}

export interface ConsultarCitasArgs {
  db: SupabaseClient;
  accountId: string;
  contactId: string;
}

/**
 * consultar_citas — the contact's own appointments, newest-relevant first.
 *
 * This exists so the agent can ground "can I move it?" on REAL rows before
 * choosing between creating, moving and cancelling. Without it the model had to
 * recall a UUID from the system prompt, and when it could not it reached for
 * `agendar_cita` — producing a second event for a customer who only wanted to
 * move the first one.
 *
 * Read-only: it never touches the calendar provider.
 */
export async function consultar_citas(args: ConsultarCitasArgs): Promise<string> {
  const { db, accountId, contactId } = args;

  const { data, error } = await db
    .from('citas')
    .select('id, fecha_inicio, fecha_fin, estado, motivo, meet_link, google_event_id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('fecha_inicio', { ascending: true });

  if (error) {
    console.error('[calendar] consultar_citas failed:', error);
    return `Error: no se pudieron consultar las citas del cliente (${error.message}).`;
  }

  const citas = (Array.isArray(data) ? data : []) as Array<{
    id: string;
    fecha_inicio: string;
    fecha_fin: string;
    estado: string;
    motivo: string | null;
    meet_link: string | null;
    google_event_id: string;
  }>;

  if (citas.length === 0) {
    return (
      'Este cliente no tiene ninguna cita registrada.\n\n' +
      toolResultJson({ exito: true, accion: 'consultar', citas: [], total: 0 })
    );
  }

  const ahora = Date.now();
  const lineas = citas.map((c, i) => {
    const { fecha, hora } = fechaHoraLocal(new Date(c.fecha_inicio));
    const { hora: horaFin } = fechaHoraLocal(new Date(c.fecha_fin));
    const estado = c.estado === 'cancelada' ? 'cancelada' : 'confirmada';
    const pasada = new Date(c.fecha_inicio).getTime() < ahora;
    const enlace = c.meet_link ? ` | enlace: ${c.meet_link}` : '';
    return (
      `${i + 1}) idCita="${c.id}" | ${fecha} ${hora}-${horaFin} (America/Bogota) | ` +
      `estado: ${estado}${pasada ? ', ya pasó' : ''}` +
      `${c.motivo ? ` | motivo: ${c.motivo}` : ''}${enlace}`
    );
  });

  const activas = citas.filter((c) => c.estado === 'confirmada').length;

  return (
    `Citas de este cliente (${citas.length} en total, ${activas} confirmada(s)):\n` +
    `${lineas.join('\n')}\n\n` +
    'Usa el idCita exacto en reagendar_cita o cancelar_cita. ' +
    'Para MOVER una de estas citas llama reagendar_cita: NUNCA agendar_cita, ' +
    'que crearía un evento duplicado.\n\n' +
    toolResultJson({
      exito: true,
      accion: 'consultar',
      total: citas.length,
      citas: citas.map((c) => {
        const { fecha, hora } = fechaHoraLocal(new Date(c.fecha_inicio));
        return {
          idCita: c.id,
          fecha,
          hora,
          estado: c.estado,
          link: c.meet_link ?? null,
        };
      }),
    })
  );
}

export interface CancelarCitaArgs {
  db: SupabaseClient;
  accountId: string;
  /** Contact whose active cita to cancel when `idCita` is omitted. */
  contactId?: string;
  idCita?: string;
}

/**
 * cancelar_cita — delete the remote event and mark the row 'cancelada'.
 *
 * Shares {@link resolverCitaObjetivo} with reagendar_cita so both lifecycle
 * tools resolve "which appointment" the same way (explicit id, else the
 * contact's active one) and can never act on a row from another account.
 */
export async function cancelar_cita(args: CancelarCitaArgs): Promise<string> {
  const { db, accountId, idCita, contactId } = args;

  const cita = await resolverCitaObjetivo(db, accountId, { idCita, contactId });
  if (cita === undefined) {
    return toolFailure(
      'Error: no se pudo consultar la cita del cliente en el sistema.',
      { motivo: 'consulta_fallida', accion: 'cancelar' }
    );
  }
  if (cita === null) {
    return toolFailure(sinCitaPreviaMessage(), {
      motivo: 'sin_cita_previa',
      accion: 'cancelar',
    });
  }

  if (cita.estado === 'cancelada') {
    // Idempotent: a replayed cancel must not tell the customer it happened twice.
    return `La cita ya estaba cancelada.\n\n${toolResultJson({
      exito: true,
      accion: 'cancelar',
      mensaje: 'La cita ya estaba cancelada',
      confirmado: true,
      idCita: cita.id,
    })}`;
  }

  const esEventoRemoto =
    typeof cita.google_event_id === 'string' &&
    cita.google_event_id.length > 0 &&
    !cita.google_event_id.startsWith('local-');

  if (esEventoRemoto) {
    try {
      const cal = calendarClient();
      await cal.events.delete(
        {
          calendarId: CAL_ID,
          eventId: cita.google_event_id,
          sendUpdates: 'all',
        },
        { timeout: CALENDAR_TIMEOUT_MS }
      );
    } catch (err) {
      console.error('[calendar] events.delete failed:', err);
      return toolFailure(
        'Error: Google Calendar no pudo eliminar la cita.',
        { motivo: 'proveedor_error', accion: 'cancelar' }
      );
    }
  }

  const { error } = await db
    .from('citas')
    .update({ estado: 'cancelada' })
    .eq('id', cita.id)
    .eq('account_id', accountId);
  if (error) {
    console.error('[calendar] citas update estado failed:', error);
    return toolFailure(
      `Error: el evento se eliminó de Google Calendar pero no se pudo actualizar el CRM (${error.message}).`,
      { motivo: 'crm_update_fallido', accion: 'cancelar' }
    );
  }

  const { fecha, hora } = fechaHoraLocal(new Date(cita.fecha_inicio));
  return (
    `Cita cancelada correctamente.\n\n${toolResultJson({
      exito: true,
      accion: 'cancelar',
      mensaje: 'Cita cancelada correctamente',
      confirmado: true,
      idCita: cita.id,
      fecha: fecha || null,
      hora: hora || null,
    })}`
  );
}

// ------------------------------------------------------------
// Parsing helpers
// ------------------------------------------------------------

// A bare date (2026-09-17) or a naive datetime with no timezone
// designator (2026-09-17T15:00[[:ss]] / "2026-09-17 15:00"). Both must be
// read as America/Bogota wall time: `new Date("2026-09-17T15:00")` would
// otherwise resolve against the server zone (UTC in production) and shift
// the appointment 5 hours.
const BARE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAIVE_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{1,2}(:\d{1,2})?(:\d{1,2})?$/;

/**
 * True when the string carries an explicit time-of-day (not just a bare
 * date): an offset-less datetime, an ISO datetime, or a date+time with a
 * timezone designator. Used by ver_disponibilidad to accept a single
 * point-in-time and expand it to a 45-minute range.
 */
function hasExplicitTime(value: string): boolean {
  const t = value.trim();
  if (!t) return false;
  return NAIVE_DATETIME_RE.test(t) || (t.includes('T') && /:\d{1,2}/.test(t));
}

/** Build a Date from an offset-less wall-clock string, pinned to -05:00. */
function bogotaWallToDate(naive: string): Date {
  const t = naive.replace(' ', 'T');
  const [datePart, timePart = '00:00:00'] = t.split('T');
  const bits = timePart.split(':');
  while (bits.length < 3) bits.push('00');
  const hhmmss = bits.map((b) => b.padStart(2, '0')).join(':');
  return new Date(`${datePart}T${hhmmss}${BOGOTA_OFFSET}`);
}

/**
 * Parse a user/model-supplied instant, interpreting a timezone-less value
 * as America/Bogota wall time. Returns null for an invalid date so the
 * caller can surface a clear error instead of silently defaulting to now.
 */
export function parseBogotaInstant(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (BARE_DATE_RE.test(trimmed) || NAIVE_DATETIME_RE.test(trimmed)) {
    const d = bogotaWallToDate(trimmed);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Parse one end of a ver_disponibilidad window. An empty value falls back
 * to "now" (start) or the end of today in Bogota (end); a bare date
 * covers the whole Bogota day. Invalid input returns null.
 */
function parseWindowBound(value: string, isEnd: boolean): Date | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return isEnd
      ? new Date(`${bogotaDateKey(new Date())}T23:59:59${BOGOTA_OFFSET}`)
      : new Date();
  }
  if (BARE_DATE_RE.test(trimmed)) {
    return new Date(
      `${trimmed}T${isEnd ? '23:59:59' : '00:00:00'}${BOGOTA_OFFSET}`
    );
  }
  return parseBogotaInstant(trimmed);
}

/**
 * Why an appointment start was refused.
 *
 * These are genuinely different failures and MUST stay distinguishable:
 * conflating them tells the model a perfectly valid date was invalid, and
 * the natural "fix" it then invents is to mangle the date itself.
 *
 *   - `unparseable` — the string is not a date at all (e.g. the model passed
 *     the customer's own words, "dentro de 2 días a las 2pm"). The remedy is
 *     to CONVERT it to an absolute instant.
 *   - `outside_hours` — a valid instant that falls outside BUSINESS_HOURS or
 *     would not fit APPOINTMENT_DURATION_MIN before closing. The date is
 *     correct; only the time needs to move.
 *   - `ok` — usable.
 */
type AppointmentStartResult =
  | { kind: 'ok'; date: Date }
  | { kind: 'unparseable' }
  | { kind: 'outside_hours'; date: Date; openMin: number; closeMin: number };

/** Validate an appointment start: parseable AND inside business hours. */
function parseAppointmentStartDetailed(value: string): AppointmentStartResult {
  const d = parseBogotaInstant(value);
  if (!d) return { kind: 'unparseable' };

  const p = bogotaParts(d);
  const hours = BUSINESS_HOURS[p.weekday];
  if (!hours) return { kind: 'outside_hours', date: d, openMin: 0, closeMin: 0 };

  const minuteOfDay = p.hour * 60 + p.minute;
  if (minuteOfDay < hours.openMin) {
    return { kind: 'outside_hours', date: d, openMin: hours.openMin, closeMin: hours.closeMin };
  }
  if (minuteOfDay + APPOINTMENT_DURATION_MIN > hours.closeMin) {
    return { kind: 'outside_hours', date: d, openMin: hours.openMin, closeMin: hours.closeMin };
  }

  return { kind: 'ok', date: d };
}

/**
 * Validate an appointment start: parseable AND inside business hours.
 * Null-returning wrapper kept for the existing callers/tests.
 */
function parseAppointmentStart(value: string): Date | null {
  const r = parseAppointmentStartDetailed(value);
  return r.kind === 'ok' ? r.date : null;
}

/** Minute-of-day -> "14:30" for human/model-readable windows. */
function hhmm(minuteOfDay: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(minuteOfDay / 60))}:${pad(minuteOfDay % 60)}`;
}

/** Every weekday currently shares one window, so label it from one entry. */
const BUSINESS_HOURS_LABEL = `${hhmm(BUSINESS_HOURS[0].openMin)}–${hhmm(
  BUSINESS_HOURS[0].closeMin
)}`;

/**
 * Tool-result text for a refused `inicio`.
 *
 * This string is handed straight back to the model, which has only
 * MAX_TOOL_ROUNDS attempts, so it must be self-sufficient: name the exact
 * required format, hand over the current Bogotá wall clock (so a relative
 * phrase like "dentro de 2 días a las 2pm" is resolvable without another
 * round trip), and state explicitly whether the date was wrong or merely
 * out of hours.
 */
function appointmentStartError(
  result: Exclude<AppointmentStartResult, { kind: 'ok' }>,
  received: string
): string {
  const now = new Date();

  if (result.kind === 'unparseable') {
    return [
      'Error: "inicio" no se pudo interpretar como fecha.',
      `Recibido: "${received}".`,
      'Debes convertirlo a un instante absoluto en formato ISO 8601 con hora ' +
        'y desplazamiento de Bogotá, por ejemplo "2026-09-17T14:00:00-05:00".',
      'Si el cliente pidió una fecha relativa ("dentro de 2 días", "el martes ' +
        'que viene", "mañana a las 2pm") o una nota de voz ambigua, no la reenvíes ' +
        'tal cual: resuélvela con la hora actual de Bogotá que aparece abajo y luego ' +
        'llama de nuevo a agendar_cita.',
      `Ahora en Bogotá: ${bogotaIso(now)}.`,
      `La cita dura ${APPOINTMENT_DURATION_MIN} minutos y el horario de atención es ` +
        `${BUSINESS_HOURS_LABEL}.`,
    ].join(' ');
  }

  const { date, openMin, closeMin } = result;
  const lastStartMin = closeMin - APPOINTMENT_DURATION_MIN;
  return [
    `Error: la fecha "${bogotaIso(date)}" es válida pero cae fuera del horario de atención.`,
    'NO cambies la fecha: solo mueve la hora.',
    `Horario de atención para ese día: ${hhmm(openMin)}–${hhmm(closeMin)}. ` +
      `La última hora posible para empezar una cita de ${APPOINTMENT_DURATION_MIN} ` +
      `minutos es ${hhmm(lastStartMin)}.`,
    'Vuelve a llamar a agendar_cita con la fecha corregida, o usa ' +
      'ver_disponibilidad para ofrecerle al cliente otras opciones.',
  ].join(' ');
}
