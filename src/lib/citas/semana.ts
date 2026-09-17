// ============================================================
// Weekly-calendar math for the /calendario grid, shared by the RSC
// page and its client interaction island. Everything is pinned to the
// America/Bogota wall clock (UTC-5, no DST) so the grid matches the
// calendar's business hours regardless of the server or viewer zone.
//
// Pure + dependency-free (Intl only) so it can run in a Server
// Component or a "use client" component without pulling the calendar
// SDKs into the client bundle.
// ============================================================

export const CAL_TZ = 'America/Bogota'

/** Monday..Sunday short labels used by the grid header. */
export const DIAS_CORTOS = ['LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB', 'DOM'] as const

/** Business day window (Mon-Fri). The column height is this span. */
export const INICIO_LABORAL_MIN = 9 * 60 // 09:00
export const FIN_LABORAL_MIN = 18 * 60 // 18:00
export const DURACION_LABORAL_MIN = FIN_LABORAL_MIN - INICIO_LABORAL_MIN // 540

export interface BogotaClock {
  year: number
  /** 1-12 */
  month: number
  day: number
  hour: number
  minute: number
  /** 0=Sun .. 6=Sat (JS getDay() order) */
  weekday: number
}

const pad2 = (n: number) => String(n).padStart(2, '0')

const wallFmt = new Intl.DateTimeFormat('en', {
  timeZone: CAL_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  hour12: false,
})

/** Split an instant into its America/Bogota wall-clock components. */
export function bogotaClock(date: Date): BogotaClock {
  const parts = Object.fromEntries(
    wallFmt
      .formatToParts(date)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  )
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
      parts.weekday,
    ),
  }
}

/** Bogota YYYY-MM-DD of an instant. */
export function bogotaDateKey(date: Date): string {
  const p = bogotaClock(date)
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`
}

const horaFmt = new Intl.DateTimeFormat('es-CO', {
  timeZone: CAL_TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/**
 * "HH:mm" of an ISO instant in Bogota wall time — used for block labels so
 * the displayed time always matches the grid's Bogota-pinned position,
 * regardless of the viewer's own timezone.
 */
export function bogotaHora(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  return horaFmt.format(d)
}

/** Wall-clock minutes since midnight (0..1439) of an instant in Bogota. */
export function bogotaMinuteOfDay(date: Date): number {
  const p = bogotaClock(date)
  return p.hour * 60 + p.minute
}

/** Instant whose Bogota wall clock reads `dateKey` at `minuteOfDay`. */
export function bogotaWallInstant(dateKey: string, minuteOfDay: number): Date {
  const [y, m, d] = dateKey.split('-').map(Number)
  const h = Math.floor(minuteOfDay / 60)
  const min = minuteOfDay % 60
  const approx = new Date(Date.UTC(y, m - 1, d, h, min, 0, 0))
  const p = bogotaClock(approx)
  const delta = (p.hour * 60 + p.minute) - (h * 60 + min)
  return new Date(approx.getTime() - delta * 60_000)
}

/** Add `dias` days to a YYYY-MM-DD key (handles month/year edges). */
export function sumarFechaKey(dateKey: string, dias: number): string {
  const base = bogotaWallInstant(dateKey, 12 * 60)
  return bogotaDateKey(new Date(base.getTime() + dias * 86_400_000))
}

/** Bogota YYYY-MM-DD for "today" (evaluated at call time). */
export function hoyBogota(): string {
  return bogotaDateKey(new Date())
}

// ------------------------------------------------------------
// ISO week arithmetic. An ISO week 1 is the week containing Jan 4;
// keys are treated as plain dates so the math is zone-independent.
// ------------------------------------------------------------

function isoWeekOfDate(date: Date): { anio: number; semana: number } {
  // Move to the Thursday of this week — it always sits in the ISO week.
  const dayNum = date.getUTCDay() || 7 // Mon=1..Sun=7
  const thursday = new Date(date.getTime())
  thursday.setUTCDate(thursday.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1))
  const dayIndex = (thursday.getTime() - yearStart.getTime()) / 86_400_000
  const semana = Math.ceil((dayIndex + 1) / 7)
  return { anio: thursday.getUTCFullYear(), semana }
}

/** {anio, semana} (ISO) for a Bogota dateKey. */
export function isoWeekOfDateKey(dateKey: string): { anio: number; semana: number } {
  const [y, m, d] = dateKey.split('-').map(Number)
  // Noon UTC keeps the arithmetic date-boundary-free.
  return isoWeekOfDate(new Date(Date.UTC(y, m - 1, d, 12, 0, 0)))
}

/**
 * Monday of ISO week `semana` in `anio`, as a Bogota dateKey. Week 1's
 * Monday is the Monday on/before Jan 4.
 */
export function mondayOfIsoWeek(anio: number, semana: number): string {
  const jan4 = new Date(Date.UTC(anio, 0, 4, 12, 0, 0))
  const dayNum = jan4.getUTCDay() || 7 // Mon=1..Sun=7
  const week1Monday = new Date(Date.UTC(anio, 0, 4 + 1 - dayNum, 12, 0, 0))
  const monday = new Date(
    week1Monday.getTime() + (semana - 1) * 7 * 86_400_000,
  )
  return monday.toISOString().slice(0, 10)
}

/** Number of ISO weeks in `anio` (52 or 53). */
export function maxSemanaDeAnio(anio: number): number {
  return isoWeekOfDateKey(`${anio}-12-28`).semana
}

/** The ISO week matching "now" in Bogota. */
export function semanaActualBogota(): { anio: number; semana: number } {
  return isoWeekOfDateKey(hoyBogota())
}

/** Move `delta` ISO weeks (positive=next, negative=prev) across years. */
export function sumarSemana(
  anio: number,
  semana: number,
  delta: number,
): { anio: number; semana: number } {
  let a = anio
  let s = semana + delta
  while (s < 1) {
    a -= 1
    s = maxSemanaDeAnio(a)
  }
  while (s > maxSemanaDeAnio(a)) {
    s -= maxSemanaDeAnio(a)
    a += 1
  }
  return { anio: a, semana: s }
}

/** Clamp an out-of-range week to the valid range of `anio`. */
export function clampSemana(anio: number, semana: number): { anio: number; semana: number } {
  const max = maxSemanaDeAnio(anio)
  return { anio, semana: Math.min(Math.max(1, Math.floor(semana)), max) }
}

// ------------------------------------------------------------
// Grid geometry (block placement within a 540px-tall day column).
// Positions are offsets in minutes relative to 09:00 (INICIO_LABORAL_MIN);
// the column is DURACION_LABORAL_MIN = 540min, so top/height in px = value.
// ------------------------------------------------------------

export interface BloqueRango {
  /** px offset from the top of the day column (0 = 09:00 Bogota). */
  inicioMin: number
  /** px offset of the block's bottom edge (540 = 18:00 Bogota). */
  finMin: number
}

/** Position of an appointment within the grid on `fechaKey` (or null). */
export function citaRango(
  fechaKey: string,
  inicioIso: string,
  finIso?: string | null,
): BloqueRango | null {
  const start = new Date(inicioIso)
  if (Number.isNaN(start.getTime()) || bogotaDateKey(start) !== fechaKey) {
    return null
  }
  const end = finIso
    ? new Date(finIso)
    : new Date(start.getTime() + 45 * 60_000)
  if (Number.isNaN(end.getTime())) return null

  const s = bogotaMinuteOfDay(start)
  let e = bogotaMinuteOfDay(end)
  const sClamped = Math.max(s, INICIO_LABORAL_MIN)
  if (sClamped >= FIN_LABORAL_MIN || e <= INICIO_LABORAL_MIN) return null
  e = Math.min(Math.max(e, sClamped + 1), FIN_LABORAL_MIN)
  if (sClamped >= e) return null
  return {
    inicioMin: sClamped - INICIO_LABORAL_MIN,
    finMin: e - INICIO_LABORAL_MIN,
  }
}

/** Busy interval clipped to the laboral window of `fechaKey`. */
export function ocupadoRango(
  fechaKey: string,
  startIso: string,
  endIso: string,
): BloqueRango | null {
  const start = new Date(startIso)
  const end = new Date(endIso)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null
  const dayStart = bogotaWallInstant(fechaKey, INICIO_LABORAL_MIN).getTime()
  const dayEnd = bogotaWallInstant(fechaKey, FIN_LABORAL_MIN).getTime()
  const s = Math.max(start.getTime(), dayStart)
  const e = Math.min(end.getTime(), dayEnd)
  if (s >= e) return null
  return {
    inicioMin: (s - dayStart) / 60_000,
    finMin: (e - dayStart) / 60_000,
  }
}

/** Browser-local "YYYY-MM-DDTHH:mm" for a `<input type="datetime-local">`. */
export function aLocalInput(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
    date.getDate(),
  )}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}