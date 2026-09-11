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
  insert: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}))

vi.mock('@googleapis/calendar', () => ({
  calendar: vi.fn(() => ({
    freebusy: { query: h.freebusy },
    events: { insert: h.insert, patch: h.patch, delete: h.del },
  })),
}))

vi.mock('google-auth-library', () => ({
  JWT: class {},
}))

import {
  agendar_cita,
  cancelar_cita,
  reagendar_cita,
  ver_disponibilidad,
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

  it('lists consecutive 30-min-aligned 60-min slots on business days', async () => {
    const out = await ver_disponibilidad('2026-09-14', '2026-09-18')
    expect(out).toContain('lunes 2026-09-14')
    expect(out).toContain('viernes 2026-09-18')
    // Weekday 09:00-18:00 → starts 09:00..17:00 (17 slots), each 30-min aligned.
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
          summary: 'María Pérez — Cotización',
          start: expect.objectContaining({ dateTime: expect.stringContaining('2026-09-14T10:00:00') }),
        }),
      }),
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
    )
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

describe('APPOINTMENT_DURATION_MIN', () => {
  it('is exactly 60 minutes', () => {
    expect(APPOINTMENT_DURATION_MIN).toBe(60)
  })
})