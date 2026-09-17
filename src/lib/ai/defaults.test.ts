import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  aiTimeZone,
  buildSystemPrompt,
  currentDateTimeContext,
  todayContextLine,
} from './defaults'

const REAL_TZ = process.env.AI_TIMEZONE

beforeEach(() => {
  process.env.AI_TIMEZONE = 'America/Bogota'
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-14T12:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
  if (REAL_TZ === undefined) {
    delete process.env.AI_TIMEZONE
  } else {
    process.env.AI_TIMEZONE = REAL_TZ
  }
})

describe('currentDateTimeContext', () => {
  it('computes the wall-clock in the business timezone', () => {
    // 2026-09-14T12:00:00Z = 07:00 in America/Bogota (UTC-5, no DST).
    expect(aiTimeZone()).toBe('America/Bogota')
    expect(currentDateTimeContext()).toEqual({
      weekday: 'lunes',
      date: '2026-09-14',
      time: '07:00',
    })
  })

  it('defaults to America/Bogota when AI_TIMEZONE is unset', () => {
    delete process.env.AI_TIMEZONE
    expect(aiTimeZone()).toBe('America/Bogota')
  })
})

describe('todayContextLine', () => {
  it('emits the fixed Spanish header with weekday, YYYY-MM-DD and 24h HH:MM', () => {
    expect(todayContextLine()).toBe(
      'INFORMACIÓN DE FECHA Y HORA ACTUAL: Hoy es lunes, 2026-09-14, hora local 07:00 (America/Bogota)',
    )
  })
})

describe('buildSystemPrompt', () => {
  it('prepends the today line as the opening instruction', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'draft' })

    const [first] = prompt.split('\n\n')
    expect(first).toBe(
      'INFORMACIÓN DE FECHA Y HORA ACTUAL: Hoy es lunes, 2026-09-14, hora local 07:00 (America/Bogota)',
    )
    expect(prompt).toContain('You are a customer-messaging assistant for a business')
  })

  it('orders direct booking in the same turn once the customer gave a date', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      calendarEnabled: true,
    })
    expect(prompt).toContain('call agendar_cita in THIS SAME TURN')
    expect(prompt).toContain('DO NOT ask again for the date')
    expect(prompt).toContain('never stop the flow to ask for the reason')
    expect(prompt).toContain('confirmado: true')
    expect(prompt).toContain('a missing email must never block the booking')
  })

  it('forbids re-asking for the date range in the confirmation protocol', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    expect(prompt).toContain('must NOT ask a customer who already confirmed a date/time for "rangos de fechas"')
    expect(prompt).toContain('"Consulta / Valoración"')
  })

  it('forbids inventing Meet/calendar URLs and trusts the configured credentials', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      calendarEnabled: true,
    })
    expect(prompt).toContain('PROHIBIDO inventar URLs')
    expect(prompt).toContain('meet.google.com/xxx-yyyy-zzz')
    expect(prompt).toContain('Confía plenamente en que las credenciales')
    expect(prompt).toContain('ejecuta el tool_call directamente')
  })
})