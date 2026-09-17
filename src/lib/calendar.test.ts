import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.hoisted(() => {
  process.env.GOOGLE_CALENDAR_ID = 'hma-test@serviceaccount.test'
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
    type: 'service_account',
    project_id: 'test-project',
    private_key_id: 'k',
    private_key: '-----BEGIN PRIVATE KEY-----\\nTESTKEY\\n-----END PRIVATE KEY-----\n',
    client_email: 'bot@test-project.iam.gserviceaccount.com',
    client_id: '123',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/bot%40test-project.iam.gserviceaccount.com',
  })
})

const h = vi.hoisted(() => ({
  freebusy: vi.fn(),
  list: vi.fn(),
  insert: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}))

vi.mock('@googleapis/calendar', () => ({
  calendar: vi.fn(() => ({
    freebusy: { query: h.freebusy },
    events: { list: h.list, insert: h.insert, patch: h.patch, delete: h.del },
  })),
}))

vi.mock('google-auth-library', () => ({
  JWT: class {},
  OAuth2Client: class {
    setCredentials() {}
  },
}))

import {
  agendar_cita,
  cancelar_cita,
  reagendar_cita,
  ver_disponibilidad,
  listar_eventos,
  consultarOcupados,
  parseBogotaInstant,
  APPOINTMENT_DURATION_MIN,
} from '@/lib/calendar'

function db() {
  const callLog: Array<Record<string, unknown>> = []
  return {
    callLog,
    from: (table: string) => ({
      _table: table,
      insert: (row: Record<string, unknown>) => {
        callLog.push({ op: 'insert', table, row })
        return {
          select: () => ({
            single: async () => ({ data: { id: 'cita-1' }, error: null }),
          }),
        }
      },
      update: (patch: Record<string, unknown>) => {
        callLog.push({ op: 'update', table, patch })
        return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }
      },
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }),
  }
}

function freebusyEmpty(): { data: Record<string, unknown> } {
  return {
    data: { calendars: { [process.env.GOOGLE_CALENDAR_ID!]: { busy: [] } } },
  }
}

describe('ver_disponibilidad', () => {
  beforeEach(() => {
    h.freebusy.mockReset()
    h.freebusy.mockResolvedValue(freebusyEmpty())
  })

  it('lists consecutive 30-min-aligned 45-min slots on business days', async () => {
    const out = await ver_disponibilidad('2026-09-14', '2026-09-18')
    expect(out).toContain('lunes 2026-09-14')
    expect(out).toContain('viernes 2026-09-18')
    // Weekday 09:00-18:00, 45-min slots → starts 09:00..17:00 (17 slots).
    const mondayLine = out.split('\n').find((l) => l.startsWith('lunes'))
    expect(mondayLine?.match(/-05:00/g)).toHaveLength(17)
    expect(out).not.toMatch(/s[áa]bado|domingo/)
  })

  it('honors business hours on Saturday (09:00-13:00)', async () => {
    const out = await ver_disponibilidad('2026-09-19', '2026-09-19')
    const saturdayLine = out.split('\n').find((l) => l.startsWith('sábado'))
    // 09:00..12:00 → 7 starts.
    expect(saturdayLine?.match(/-05:00/g)).toHaveLength(7)
  })

  it('excludes slots that overlap busy periods', async () => {
    h.freebusy.mockResolvedValue({
      data: {
        calendars: {
          [process.env.GOOGLE_CALENDAR_ID!]: {
            busy: [
              { start: '2026-09-14T15:00:00-05:00', end: '2026-09-14T16:30:00-05:00' },
            ],
          },
        },
      },
    })
    const out = await ver_disponibilidad('2026-09-14', '2026-09-14')
    const line = out.split('\n').find((l) => l.startsWith('lunes'))
    // 15:00, 15:30 and 16:00 are gone (busy until 16:30).
    expect(line).not.toContain('2026-09-14T15:00:00-05:00')
    expect(line).not.toContain('2026-09-14T15:30:00-05:00')
    expect(line).not.toContain('2026-09-14T16:00:00-05:00')
    expect(line).toContain('2026-09-14T16:30:00-05:00')
  })

  it('reports no availability when everything is busy', async () => {
    h.freebusy.mockResolvedValue({
      data: {
        calendars: {
          [process.env.GOOGLE_CALENDAR_ID!]: {
            busy: [
              { start: '2026-09-14T00:00:00-05:00', end: '2026-09-19T00:00:00-05:00' },
            ],
          },
        },
      },
    })
    const out = await ver_disponibilidad('2026-09-14', '2026-09-18')
    expect(out).toContain('No hay horarios disponibles')
  })

  it('rejects an inverted range', async () => {
    const out = await ver_disponibilidad('2026-09-20', '2026-09-10')
    expect(out).toContain('Error')
  })

  it('reports a clear error for an unparseable date', async () => {
    const out = await ver_disponibilidad('no-es-fecha', '2026-09-18')
    expect(out).toContain('fecha inválida')
  })
})

describe('parseBogotaInstant', () => {
  it('interprets an offset-less ISO datetime as Bogota wall time', () => {
    const d = parseBogotaInstant('2026-09-17T15:00:00')
    expect(d?.toISOString()).toBe('2026-09-17T20:00:00.000Z')
  })

  it('interprets a bare date as Bogota midnight', () => {
    const d = parseBogotaInstant('2026-09-17')
    expect(d?.toISOString()).toBe('2026-09-17T05:00:00.000Z')
  })

  it('honors an explicit -05:00 offset', () => {
    const d = parseBogotaInstant('2026-09-17T15:00:00-05:00')
    expect(d?.toISOString()).toBe('2026-09-17T20:00:00.000Z')
  })

  it('returns null for a non-date string', () => {
    expect(parseBogotaInstant('mañana por la tarde')).toBeNull()
  })
})

describe('agendar_cita', () => {
  beforeEach(() => {
    h.freebusy.mockReset()
    h.freebusy.mockResolvedValue(freebusyEmpty())
    h.insert.mockReset()
    h.insert.mockResolvedValue({ data: { id: 'evt-123' } })
  })

  it('creates the Google event and persists the CRM row', async () => {
    const supabase = db()
    const out = await agendar_cita({
      db: supabase as never,
      accountId: 'acct-1',
      contactoId: 'contact-1',
      inicio: '2026-09-14T10:00:00-05:00',
      nombre: 'María Pérez',
      motivo: 'Cotización',
    })
    expect(out).toContain('Cita agendada')
    expect(out).toContain('2026-09-14T10:00:00-05:00')
    expect(h.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: process.env.GOOGLE_CALENDAR_ID,
        requestBody: expect.objectContaining({
          summary: 'Cita con Cliente - María Pérez',
          start: expect.objectContaining({ dateTime: expect.stringContaining('2026-09-14T10:00:00') }),
        }),
      }),
      expect.objectContaining({ timeout: 8000 }),
    )
    const insert = supabase.callLog.find((c) => c.op === 'insert' && c.table === 'citas')
    expect(insert).toMatchObject({
      row: {
        account_id: 'acct-1',
        contact_id: 'contact-1',
        google_event_id: 'evt-123',
        estado: 'confirmada',
        motivo: 'Cotización',
      },
    })
    const end = insert!.row as { fecha_fin: string }
    expect((end.fecha_fin as unknown as string).length).toBeGreaterThan(0)
  })

  it('refuses an out-of-business-hours start', async () => {
    const supabase = db()
    const out = await agendar_cita({
      db: supabase as never,
      accountId: 'acct-1',
      contactoId: 'contact-1',
      inicio: '2026-09-14T19:00:00-05:00',
      nombre: 'X',
    })
    expect(out).toContain('Error')
    expect(h.insert).not.toHaveBeenCalled()
  })

  it('accepts an offset-less datetime as Bogota wall time', async () => {
    const supabase = db()
    const out = await agendar_cita({
      db: supabase as never,
      accountId: 'acct-1',
      contactoId: 'contact-1',
      inicio: '2026-09-14T10:00:00',
      nombre: 'X',
    })
    expect(out).toContain('Cita agendada')
    const args = h.insert.mock.calls[0][0] as {
      requestBody: { start: { dateTime: string } }
    }
    expect(args.requestBody.start.dateTime).toBe('2026-09-14T10:00:00-05:00')
  })

  it('books a 45-minute event (end = start + APPOINTMENT_DURATION_MIN)', async () => {
    const supabase = db()
    await agendar_cita({
      db: supabase as never,
      accountId: 'acct-1',
      contactoId: 'contact-1',
      inicio: '2026-09-14T10:00:00-05:00',
      nombre: 'X',
    })
    const args = h.insert.mock.calls[0][0] as {
      requestBody: { end: { dateTime: string } }
    }
    expect(args.requestBody.end.dateTime).toBe('2026-09-14T10:45:00-05:00')
    const insert = supabase.callLog.find(
      (c) => c.op === 'insert' && c.table === 'citas',
    )
    const row = insert!.row as { fecha_inicio: string; fecha_fin: string }
    expect(
      new Date(row.fecha_fin).getTime() - new Date(row.fecha_inicio).getTime(),
    ).toBe(45 * 60 * 1000)
  })

  it('refuses a slot that is already occupied', async () => {
    h.freebusy.mockResolvedValue({
      data: {
        calendars: {
          [process.env.GOOGLE_CALENDAR_ID!]: {
            busy: [
              { start: '2026-09-14T10:00:00-05:00', end: '2026-09-14T11:00:00-05:00' },
            ],
          },
        },
      },
    })
    const supabase = db()
    const out = await agendar_cita({
      db: supabase as never,
      accountId: 'acct-1',
      contactoId: 'contact-1',
      inicio: '2026-09-14T10:00:00-05:00',
      nombre: 'X',
    })
    expect(out).toContain('ya está ocupado')
    expect(h.insert).not.toHaveBeenCalled()
  })
})

describe('reagendar_cita / cancelar_cita', () => {
  beforeEach(() => {
    h.freebusy.mockReset()
    h.freebusy.mockResolvedValue(freebusyEmpty())
    h.patch.mockReset()
    h.patch.mockResolvedValue({ data: {} })
    h.del.mockReset()
    h.del.mockResolvedValue({ data: '' })
  })

  it('patches the remote event and updates the CRM row', async () => {
    const supabase = {
      from: (table: string) => {
        if (table === 'citas') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: 'cita-1',
                      account_id: 'acct-1',
                      google_event_id: 'evt-123',
                      fecha_inicio: '2026-09-08T10:00:00-05:00',
                    },
                    error: null,
                  }),
                }),
              }),
            }),
            update: () => ({
              eq: () => ({ eq: () => Promise.resolve({ error: null }) }),
            }),
          }
        }
        return {}
      },
    } as never
    const out = await reagendar_cita({
      db: supabase,
      accountId: 'acct-1',
      idCita: 'cita-1',
      nuevoInicio: '2026-09-15T11:00:00-05:00',
    })
    expect(out).toContain('Cita reagendada')
    expect(h.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: process.env.GOOGLE_CALENDAR_ID,
        eventId: 'evt-123',
        requestBody: expect.objectContaining({
          start: expect.objectContaining({ dateTime: expect.stringContaining('2026-09-15T11:00:00') }),
        }),
      }),
      expect.objectContaining({ timeout: 8000 }),
    )
  })

  it('ignores the appointment\'s OWN slot as busy when rescheduling', async () => {
    // The new time equals the current time (a no-op move). freebusy
    // reports the event's own interval as busy; reagendar must NOT
    // treat that self-slot as an obstacle.
    const selfStart = '2026-09-10T10:00:00-05:00'
    const selfEnd = '2026-09-10T11:00:00-05:00'
    h.freebusy.mockResolvedValue({
      data: {
        calendars: {
          [process.env.GOOGLE_CALENDAR_ID!]: {
            busy: [{ start: selfStart, end: selfEnd }],
          },
        },
      },
    })
    const supabase = {
      from: (table: string) => {
        if (table === 'citas') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: 'cita-1',
                      account_id: 'acct-1',
                      google_event_id: 'evt-123',
                      fecha_inicio: selfStart,
                    },
                    error: null,
                  }),
                }),
              }),
            }),
            update: () => ({
              eq: () => ({ eq: () => Promise.resolve({ error: null }) }),
            }),
          }
        }
        return {}
      },
    } as never
    const out = await reagendar_cita({
      db: supabase,
      accountId: 'acct-1',
      idCita: 'cita-1',
      nuevoInicio: selfStart,
    })
    expect(out).toContain('Cita reagendada')
    expect(h.freebusy).toHaveBeenCalledTimes(1)
  })

  it('still rejects a NEW slot that is truly busy', async () => {
    // Different slot from the event's own window, genuinely occupied by
    // another event → reagendar must refuse.
    h.freebusy.mockResolvedValue({
      data: {
        calendars: {
          [process.env.GOOGLE_CALENDAR_ID!]: {
            busy: [
              {
                start: '2026-09-11T15:00:00-05:00',
                end: '2026-09-11T16:00:00-05:00',
              },
            ],
          },
        },
      },
    })
    const supabase = {
      from: (table: string) => {
        if (table === 'citas') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: 'cita-1',
                      account_id: 'acct-1',
                      google_event_id: 'evt-123',
                      fecha_inicio: '2026-09-08T10:00:00-05:00',
                    },
                    error: null,
                  }),
                }),
              }),
            }),
            update: () => ({
              eq: () => ({ eq: () => Promise.resolve({ error: null }) }),
            }),
          }
        }
        return {}
      },
    } as never
    const out = await reagendar_cita({
      db: supabase,
      accountId: 'acct-1',
      idCita: 'cita-1',
      nuevoInicio: '2026-09-11T15:00:00-05:00',
    })
    expect(out).toContain('ya está ocupado')
    // The busy slot belongs to a different window → it must NOT be excluded.
    expect(h.patch).not.toHaveBeenCalled()
  })

  it('deletes the remote event and marks the row cancelled', async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: 'cita-1',
                  account_id: 'acct-1',
                  google_event_id: 'evt-123',
                  estado: 'confirmada',
                },
                error: null,
              }),
            }),
          }),
        }),
        update: () => ({
          eq: () => ({ eq: () => Promise.resolve({ error: null }) }),
        }),
      }),
    } as never
    const out = await cancelar_cita({
      db: supabase,
      accountId: 'acct-1',
      idCita: 'cita-1',
    })
    expect(out).toContain('Cita cancelada')
    expect(h.del).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: process.env.GOOGLE_CALENDAR_ID, eventId: 'evt-123' }),
      expect.objectContaining({ timeout: 8000 }),
    )
  })

  it('reports when the appointment cannot be found', async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
      }),
    } as never
    const out = await reagendar_cita({
      db: supabase,
      accountId: 'acct-1',
      idCita: 'missing',
      nuevoInicio: '2026-09-15T11:00:00-05:00',
    })
    expect(out).toContain('no se encontró la cita')
  })
})

describe('listar_eventos', () => {
  beforeEach(() => {
    h.list.mockReset()
    h.list.mockResolvedValue({ data: {} })
  })

  it('requests maxResults=100 by default (breaks the 5-result cap)', async () => {
    await listar_eventos({})
    const args = h.list.mock.calls[0][0] as { maxResults: number }
    expect(args.maxResults).toBe(100)
  })

  it('formats items with their Meet links', async () => {
    h.list.mockResolvedValue({
      data: {
        items: [
          {
            summary: 'Cita con Cliente - Ana',
            start: { dateTime: '2026-09-20T09:00:00-05:00' },
            end: { dateTime: '2026-09-20T09:45:00-05:00' },
            hangoutLink: 'https://meet.google.com/abc',
          },
        ],
      },
    })
    const out = await listar_eventos({})
    expect(out).toContain('2026-09-20T09:00:00-05:00')
    expect(out).toContain('https://meet.google.com/abc')
  })

  it('falls back to htmlLink when the event has no Meet link', async () => {
    h.list.mockResolvedValue({
      data: {
        items: [
          {
            summary: 'Cita con Cliente - Ana',
            start: { dateTime: '2026-09-20T09:00:00-05:00' },
            end: { dateTime: '2026-09-20T09:45:00-05:00' },
            htmlLink: 'https://calendar.google.com/event?eid=abc',
          },
        ],
      },
    })
    const out = await listar_eventos({})
    expect(out).toContain('https://calendar.google.com/event?eid=abc')
  })

  it('reports an invalid window date', async () => {
    const out = await listar_eventos({ desde: 'no-es-fecha' })
    expect(out).toContain('fecha inválida')
    expect(h.list).not.toHaveBeenCalled()
  })
})

describe('agendar_cita — enlace del evento', () => {
  beforeEach(() => {
    h.freebusy.mockReset()
    h.freebusy.mockResolvedValue(freebusyEmpty())
    h.insert.mockReset()
  })

  it('persists the Meet hangoutLink in meet_link', async () => {
    h.insert.mockResolvedValue({
      data: { id: 'evt-meet', hangoutLink: 'https://meet.google.com/abc-defg-hij' },
    })
    const supabase = db()
    const out = await agendar_cita({
      db: supabase as never,
      accountId: 'acct-1',
      contactoId: 'contact-1',
      inicio: '2026-09-14T10:00:00-05:00',
      nombre: 'Ana',
    })
    expect(out).toContain('Reunión Meet: https://meet.google.com/abc-defg-hij')
    const insert = supabase.callLog.find((c) => c.op === 'insert' && c.table === 'citas')
    expect((insert!.row as { meet_link: string | null }).meet_link).toBe(
      'https://meet.google.com/abc-defg-hij',
    )
  })

  it('falls back to htmlLink and does NOT report a system error', async () => {
    h.insert.mockResolvedValue({
      data: { id: 'evt-html', htmlLink: 'https://calendar.google.com/event?eid=xyz' },
    })
    const supabase = db()
    const out = await agendar_cita({
      db: supabase as never,
      accountId: 'acct-1',
      contactoId: 'contact-1',
      inicio: '2026-09-14T10:00:00-05:00',
      nombre: 'Ana',
    })
    expect(out).toContain('Cita agendada')
    expect(out).toContain('Enlace del evento: https://calendar.google.com/event?eid=xyz')
    expect(out).not.toContain('no disponible')
    const insert = supabase.callLog.find((c) => c.op === 'insert' && c.table === 'citas')
    expect((insert!.row as { meet_link: string | null }).meet_link).toBe(
      'https://calendar.google.com/event?eid=xyz',
    )
  })

  it('confirms the appointment even with no link at all', async () => {
    h.insert.mockResolvedValue({ data: { id: 'evt-plain' } })
    const supabase = db()
    const out = await agendar_cita({
      db: supabase as never,
      accountId: 'acct-1',
      contactoId: 'contact-1',
      inicio: '2026-09-14T10:00:00-05:00',
      nombre: 'Ana',
    })
    expect(out).toContain('Cita agendada')
    const insert = supabase.callLog.find((c) => c.op === 'insert' && c.table === 'citas')
    expect((insert!.row as { meet_link: string | null }).meet_link).toBeNull()
  })
})

describe('consultarOcupados', () => {
  beforeEach(() => {
    h.freebusy.mockReset()
  })

  it('returns busy intervals as ISO strings on success', async () => {
    h.freebusy.mockResolvedValue({
      data: {
        calendars: {
          [process.env.GOOGLE_CALENDAR_ID!]: {
            busy: [
              { start: '2026-09-14T15:00:00-05:00', end: '2026-09-14T16:00:00-05:00' },
            ],
          },
        },
      },
    })
    const res = await consultarOcupados(
      '2026-09-14T00:00:00-05:00',
      '2026-09-15T00:00:00-05:00',
    )
    expect(res.ok).toBe(true)
    expect(res.ocupados).toHaveLength(1)
    expect(res.ocupados[0].start).toBe('2026-09-14T20:00:00.000Z')
    expect(res.ocupados[0].end).toBe('2026-09-14T21:00:00.000Z')
  })

  it('degrades to ok:false with an empty list when freebusy fails', async () => {
    h.freebusy.mockRejectedValue(new Error('freebusy down'))
    const res = await consultarOcupados(
      '2026-09-14T00:00:00-05:00',
      '2026-09-15T00:00:00-05:00',
    )
    expect(res.ok).toBe(false)
    expect(res.ocupados).toEqual([])
  })

  it('rejects invalid bounds without calling freebusy', async () => {
    const res = await consultarOcupados('no-es-fecha', 'tampoco')
    expect(res.ok).toBe(false)
    expect(res.ocupados).toEqual([])
    expect(h.freebusy).not.toHaveBeenCalled()
  })
})

describe('APPOINTMENT_DURATION_MIN', () => {
  it('is exactly 45 minutes', () => {
    expect(APPOINTMENT_DURATION_MIN).toBe(45)
  })
})