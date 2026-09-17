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
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${p.hour}:${pad(p.minute)}:${pad(p.second)}${BOGOTA_OFFSET}`;
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
    return 'Error: fecha inválida. Usa formato ISO 8601 en hora de Bogotá, por ejemplo 2026-09-17 o 2026-09-17T15:00:00-05:00.';
  }

  // Flexibilidad con hora puntual: si la consulta es un único instante
  // (p. ej. desde="2026-09-18T18:00:00-05:00" con hasta igual o anterior),
  // se interpreta como el rango de 45 minutos que comienza en esa hora
  // (18:00 → 18:00-18:45) en lugar de rechazarlo. Así el modelo NUNCA
  // recibe un aviso de que no se puede verificar una hora puntual.
  if (from.getTime() >= to.getTime() && hasExplicitTime(desde)) {
    const start = parseAppointmentStart(desde);
    if (start === null) {
      return 'Error: la hora indicada no es válida o cae fuera del horario de atención (lunes a domingo de 08:00 a 23:00).';
    }
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

/** agendar_cita — create a 45-minute event and persist the CRM row. */
export async function agendar_cita(args: AgendarCitaArgs): Promise<string> {
  const { db, accountId, contactoId, inicio, nombre, motivo, correoCliente } =
    args;
  const start = parseAppointmentStart(inicio);
  if (start === null) {
    return 'Error: "inicio" no es una fecha válida o cae fuera del horario de atención.';
  }
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

  const cal = calendarClient();
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
                    requestId: `meet-crm-${Date.now()}`,
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
    const hangout = created.data.hangoutLink ?? null;
    const videoUri =
      created.data.conferenceData?.entryPoints?.find(
        (entry) => entry.entryPointType === 'video'
      )?.uri ?? null;
    const meetLink =
      hangout ?? videoUri ?? created.data.htmlLink ?? MEET_FALLBACK_LINK;
    meetUrl = meetLink;
    linkEsMeet =
      hangout !== null || videoUri !== null || meetUrl === MEET_FALLBACK_LINK;
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
    mensaje: 'Cita agendada correctamente',
    fecha,
    hora,
    link: meetUrl ?? null,
    confirmado: true,
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

  return `${resumenExito}\n\n${human}\n\nJSON_RESULT (no lo repitas en el mensaje al cliente, usa su contenido): ${JSON.stringify(structured)}`;
}

export interface ReagendarCitaArgs {
  db: SupabaseClient;
  accountId: string;
  idCita: string;
  nuevoInicio: string;
}

/** reagendar_cita — move an existing appointment to a new start time. */
export async function reagendar_cita(args: ReagendarCitaArgs): Promise<string> {
  const { db, accountId, idCita, nuevoInicio } = args;
  const start = parseAppointmentStart(nuevoInicio);
  if (start === null) {
    return 'Error: "nuevoInicio" no es una fecha válida o cae fuera del horario de atención.';
  }

  const { data: cita, error: findErr } = await db
    .from('citas')
    .select('id, google_event_id, account_id, fecha_inicio')
    .eq('id', idCita)
    .eq('account_id', accountId)
    .maybeSingle();
  if (findErr || !cita) {
    return 'Error: no se encontró la cita indicada.';
  }

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
    const busy = await fetchBusy(
      start,
      new Date(start.getTime() + APPOINTMENT_DURATION_MIN * 60_000),
      oldInterval
    );
    if (busy.length > 0) {
      return 'Error: ese horario ya está ocupado. Consulta ver_disponibilidad antes de reagendar.';
    }
  } catch (err) {
    console.error('[calendar] reagendar freebusy failed:', err);
    return 'Error: no se pudo confirmar el horario en el calendario.';
  }

  const cal = calendarClient();
  try {
    await cal.events.patch(
      {
        calendarId: CAL_ID,
        eventId: cita.google_event_id,
        sendUpdates: 'all',
        requestBody: {
          start: { dateTime: bogotaIso(start), timeZone: CAL_TIMEZONE },
          end: {
            dateTime: bogotaIso(
              new Date(start.getTime() + APPOINTMENT_DURATION_MIN * 60_000)
            ),
            timeZone: CAL_TIMEZONE,
          },
        },
      },
      { timeout: CALENDAR_TIMEOUT_MS }
    );
  } catch (err) {
    console.error('[calendar] events.patch failed:', err);
    return 'Error: Google Calendar no pudo reagendar la cita.';
  }

  const { error } = await db
    .from('citas')
    .update({
      fecha_inicio: start.toISOString(),
      fecha_fin: new Date(
        start.getTime() + APPOINTMENT_DURATION_MIN * 60_000
      ).toISOString(),
    })
    .eq('id', idCita)
    .eq('account_id', accountId);
  if (error) {
    console.error('[calendar] citas update failed:', error);
    return `Error: el evento se movió en Google Calendar pero no se pudo actualizar el CRM (${error.message}).`;
  }

  return `Cita reagendada para: ${bogotaIso(start)} (45 minutos).`;
}

export interface CancelarCitaArgs {
  db: SupabaseClient;
  accountId: string;
  idCita: string;
}

/** cancelar_cita — delete the remote event and mark the row 'cancelada'. */
export async function cancelar_cita(args: CancelarCitaArgs): Promise<string> {
  const { db, accountId, idCita } = args;

  const { data: cita, error: findErr } = await db
    .from('citas')
    .select('id, google_event_id, account_id, estado')
    .eq('id', idCita)
    .eq('account_id', accountId)
    .maybeSingle();
  if (findErr || !cita) {
    return 'Error: no se encontró la cita indicada.';
  }
  if (cita.estado === 'cancelada') {
    return 'La cita ya estaba cancelada.';
  }

  const cal = calendarClient();
  try {
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
    return 'Error: Google Calendar no pudo eliminar la cita.';
  }

  const { error } = await db
    .from('citas')
    .update({ estado: 'cancelada' })
    .eq('id', idCita)
    .eq('account_id', accountId);
  if (error) {
    console.error('[calendar] citas update estado failed:', error);
    return `Error: el evento se eliminó de Google Calendar pero no se pudo actualizar el CRM (${error.message}).`;
  }

  return 'Cita cancelada correctamente.';
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

/** Validate an appointment start: parseable AND inside business hours. */
function parseAppointmentStart(value: string): Date | null {
  const d = parseBogotaInstant(value);
  if (!d) return null;

  const p = bogotaParts(d);
  const hours = BUSINESS_HOURS[p.weekday];
  if (!hours) return null;

  const minuteOfDay = p.hour * 60 + p.minute;
  if (minuteOfDay < hours.openMin) return null;
  if (minuteOfDay + APPOINTMENT_DURATION_MIN > hours.closeMin) return null;

  return d;
}
