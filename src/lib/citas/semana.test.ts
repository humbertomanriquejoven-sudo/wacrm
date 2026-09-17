import { describe, it, expect } from 'vitest'

import {
  CAL_TZ,
  DIAS_CORTOS,
  DURACION_LABORAL_MIN,
  FIN_LABORAL_MIN,
  INICIO_LABORAL_MIN,
  aLocalInput,
  bogotaClock,
  bogotaDateKey,
  bogotaHora,
  bogotaMinuteOfDay,
  bogotaWallInstant,
  citaRango,
  clampSemana,
  hoyBogota,
  isoWeekOfDateKey,
  maxSemanaDeAnio,
  mondayOfIsoWeek,
  ocupadoRango,
  sumarFechaKey,
  sumarSemana,
} from '@/lib/citas/semana'

// 14:00 UTC === 09:00 America/Bogota (UTC-5, no DST).
const MONDAY_9AM = new Date('2026-09-14T14:00:00.000Z')

describe('constantes', () => {
  it('uses the Bogota timezone and a Monday-first week', () => {
    expect(CAL_TZ).toBe('America/Bogota')
    expect(DIAS_CORTOS).toEqual(['LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB', 'DOM'])
  })

  it('spans a 900-minute business day (08:00-23:00)', () => {
    expect(INICIO_LABORAL_MIN).toBe(480)
    expect(FIN_LABORAL_MIN).toBe(1380)
    expect(DURACION_LABORAL_MIN).toBe(900)
  })
})

describe('reloj de Bogotá', () => {
  it('splits an instant into wall-clock parts', () => {
    expect(bogotaClock(MONDAY_9AM)).toEqual({
      year: 2026,
      month: 9,
      day: 14,
      hour: 9,
      minute: 0,
      weekday: 1,
    })
  })

  it('formats a date key and a minute-of-day', () => {
    expect(bogotaDateKey(MONDAY_9AM)).toBe('2026-09-14')
    expect(bogotaMinuteOfDay(MONDAY_9AM)).toBe(540)
  })

  it('round-trips a wall-clock time back to an instant', () => {
    expect(bogotaWallInstant('2026-09-14', 540).toISOString()).toBe(
      '2026-09-14T14:00:00.000Z',
    )
  })

  it('today is a well-formed Bogota date key', () => {
    expect(hoyBogota()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('labels times in Bogota wall time regardless of the viewer zone', () => {
    expect(bogotaHora('2026-09-14T14:00:00.000Z')).toBe('09:00')
    expect(bogotaHora('no-es-fecha')).toBe('-')
  })
})

describe('aritmética de fechas', () => {
  it('adds days across a week', () => {
    expect(sumarFechaKey('2026-09-14', 6)).toBe('2026-09-20')
  })

  it('rolls over year boundaries', () => {
    expect(sumarFechaKey('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('semanas ISO', () => {
  it('resolves the ISO week of known dates', () => {
    expect(isoWeekOfDateKey('2026-01-01')).toEqual({ anio: 2026, semana: 1 })
    expect(isoWeekOfDateKey('2026-12-31')).toEqual({ anio: 2026, semana: 53 })
  })

  it('maps a date in the prior calendar year to its ISO week/year', () => {
    expect(isoWeekOfDateKey('2025-12-29')).toEqual({ anio: 2026, semana: 1 })
  })

  it('finds the Monday on/before Jan 4 for week 1', () => {
    expect(mondayOfIsoWeek(2026, 1)).toBe('2025-12-29')
    expect(mondayOfIsoWeek(2026, 2)).toBe('2026-01-05')
  })

  it('reports 52 or 53 weeks depending on the year', () => {
    expect(maxSemanaDeAnio(2025)).toBe(52)
    expect(maxSemanaDeAnio(2026)).toBe(53)
  })

  it('moves across year boundaries', () => {
    expect(sumarSemana(2026, 53, 1)).toEqual({ anio: 2027, semana: 1 })
    expect(sumarSemana(2026, 1, -1)).toEqual({ anio: 2025, semana: 52 })
  })

  it('clamps out-of-range weeks', () => {
    expect(clampSemana(2026, 0)).toEqual({ anio: 2026, semana: 1 })
    expect(clampSemana(2026, 99)).toEqual({ anio: 2026, semana: 53 })
  })
})

describe('geometría del grid', () => {
  it('places an 08:00-08:45 appointment at the top of the column', () => {
    expect(
      citaRango(
        '2026-09-14',
        '2026-09-14T13:00:00.000Z',
        '2026-09-14T13:45:00.000Z',
      ),
    ).toEqual({ inicioMin: 0, finMin: 45 })
  })

  it('rejects an appointment on another day', () => {
    expect(
      citaRango('2026-09-15', '2026-09-14T14:00:00.000Z', '2026-09-14T14:45:00.000Z'),
    ).toBeNull()
  })

  it('places a mid-morning appointment without clipping (inside 08:00-23:00)', () => {
    // 08:30-09:30 Bogota (13:30-14:30 UTC): fully inside, no clip.
    expect(
      citaRango(
        '2026-09-14',
        '2026-09-14T13:30:00.000Z',
        '2026-09-14T14:30:00.000Z',
      ),
    ).toEqual({ inicioMin: 30, finMin: 90 })
  })

  it('rejects an appointment entirely outside business hours', () => {
    expect(
      citaRango(
        '2026-09-14',
        '2026-09-14T12:00:00.000Z',
        '2026-09-14T12:45:00.000Z',
      ),
    ).toBeNull()
  })

  it('clips a busy interval to the 08:00-23:00 window', () => {
    // 08:00-19:00 Bogota (13:00Z-00:00Z next day).
    expect(
      ocupadoRango(
        '2026-09-14',
        '2026-09-14T13:00:00.000Z',
        '2026-09-15T00:00:00.000Z',
      ),
    ).toEqual({ inicioMin: 0, finMin: 660 })
  })

  it('ignores busy intervals outside the day', () => {
    expect(
      ocupadoRango(
        '2026-09-14',
        '2026-09-14T05:00:00.000Z',
        '2026-09-14T10:00:00.000Z',
      ),
    ).toBeNull()
  })
})

describe('aLocalInput', () => {
  it('emits a datetime-local value', () => {
    expect(aLocalInput(new Date(2026, 8, 14, 9, 30))).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/,
    )
  })
})
