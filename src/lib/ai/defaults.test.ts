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

  it('defaults to America/Lima when AI_TIMEZONE is unset', () => {
    delete process.env.AI_TIMEZONE
    expect(aiTimeZone()).toBe('America/Lima')
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
})