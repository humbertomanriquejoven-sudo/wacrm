import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/calendar', () => ({
  calendarConfigured: vi.fn(() => true),
  ver_disponibilidad: vi.fn(async () => 'horarios libres: L 09:00'),
  consultar_citas: vi.fn(async () => '1) idCita="cita-1" | 2026-09-20 09:00-09:45'),
  agendar_cita: vi.fn(async () => 'Cita agendada'),
  reagendar_cita: vi.fn(async () => 'Cita reagendada'),
  cancelar_cita: vi.fn(async () => 'Cita cancelada'),
  listar_eventos: vi.fn(async () => '- 2026-09-20T09:00:00-05:00 → 2026-09-20T09:45:00-05:00 | Cita'),
}))

vi.mock('@/lib/gmail', () => ({
  gmailConfigured: vi.fn(() => true),
  enviar_correo: vi.fn(async () => 'Correo enviado a ana@x.com (Gmail message id 1).'),
  leer_correos: vi.fn(async () => '- De: ana@x.com\n  Asunto: Hola'),
}))

import { executeToolCall, AI_TOOLS, VER_DISPONIBILIDAD_TOOL, AGENDAR_CITA_TOOL, REAGENDAR_CITA_TOOL, CANCELAR_CITA_TOOL, CONSULTAR_CITAS_TOOL, LISTAR_EVENTOS_TOOL, ENVIAR_CORREO_TOOL, LEER_CORREOS_TOOL } from './tools'
import * as cal from '@/lib/calendar'
import * as gmailModule from '@/lib/gmail'

const mockDb = {} as never

describe('AI_TOOLS array', () => {
  it('contains the 9 expected tools', () => {
    expect(AI_TOOLS.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'update_client_profile',
        'ver_disponibilidad',
        'consultar_citas',
        'agendar_cita',
        'reagendar_cita',
        'cancelar_cita',
        'listar_eventos',
        'enviar_correo',
        'leer_correos',
      ]),
    )
    expect(AI_TOOLS).toHaveLength(9)
  })

  it('all have name, description and required parameters', () => {
    for (const t of AI_TOOLS) {
      expect(t.name).toBeTruthy()
      expect(t.description).toBeTruthy()
      expect(t.parameters).toMatchObject({ type: 'object' })
    }
  })
})

describe('calendar tool definitions', () => {
  it('ver_disponibilidad requires desde and hasta', () => {
    expect(VER_DISPONIBILIDAD_TOOL.parameters.required).toEqual(['desde', 'hasta'])
  })
  it('agendar_cita requires inicio and nombre', () => {
    expect(AGENDAR_CITA_TOOL.parameters.required).toEqual(['inicio', 'nombre'])
  })
  it('consultar_citas takes no arguments — it always reads the current contact', () => {
    expect(CONSULTAR_CITAS_TOOL.parameters.required).toBeUndefined()
    expect(Object.keys(CONSULTAR_CITAS_TOOL.parameters.properties ?? {})).toEqual([])
  })
  it('reagendar_cita requires only nuevoInicio; the cita is resolved for it', () => {
    // idCita used to be required, which meant a model that could not recall
    // the UUID had to fall back to agendar_cita — the duplicate-event bug.
    expect(REAGENDAR_CITA_TOOL.parameters.required).toEqual(['nuevoInicio'])
    expect(REAGENDAR_CITA_TOOL.parameters.properties).toHaveProperty('idCita')
  })
  it('cancelar_cita has no required arguments', () => {
    expect(CANCELAR_CITA_TOOL.parameters.required).toBeUndefined()
  })
  it('tells the three lifecycle tools apart and forbids the duplicate path', () => {
    // The naming alone (`agendar_cita` vs `reagendar_cita`) is one character;
    // the descriptions carry the disambiguation the model actually reads.
    expect(AGENDAR_CITA_TOOL.description).toMatch(/reagendar_cita/)
    expect(AGENDAR_CITA_TOOL.description).toMatch(/duplicad/i)
    expect(REAGENDAR_CITA_TOOL.description).toMatch(/NUNCA crea un evento nuevo/i)
    expect(REAGENDAR_CITA_TOOL.description).toMatch(/NO llames agendar_cita/i)
    expect(REAGENDAR_CITA_TOOL.description).toMatch(/confirmado:true/)
    expect(CANCELAR_CITA_TOOL.description).toMatch(/reagendar_cita/)
    expect(CONSULTAR_CITAS_TOOL.description).toMatch(/reagendar_cita/)
  })
  it('enviar_correo requires to, subject and body', () => {
    expect(ENVIAR_CORREO_TOOL.parameters.required).toEqual(['to', 'subject', 'body'])
  })
  it('listar_eventos and leer_correos default to 100 items', () => {
    expect(LISTAR_EVENTOS_TOOL.description).toContain('100')
    expect(LEER_CORREOS_TOOL.description).toContain('100')
  })
})

describe('executeToolCall — calendar dispatch', () => {
  it('calls ver_disponibilidad when name matches', async () => {
    const out = await executeToolCall(mockDb, 'a', 'c', {
      id: '1', name: 'ver_disponibilidad', arguments: { desde: '2026-09-14', hasta: '2026-09-18' },
    })
    expect(out).toBe('horarios libres: L 09:00')
    expect(cal.ver_disponibilidad).toHaveBeenCalledWith('2026-09-14', '2026-09-18')
  })

  it('returns error for ver_disponibilidad when arguments are missing', async () => {
    const out = await executeToolCall(mockDb, 'a', 'c', {
      id: '2', name: 'ver_disponibilidad', arguments: {},
    })
    expect(out).toContain('Error')
  })

  it('calls agendar_cita with the contact id and motivo', async () => {
    const out = await executeToolCall(mockDb, 'acct', 'contact-9', {
      id: '3', name: 'agendar_cita', arguments: {
        inicio: '2026-09-14T10:00:00-05:00', nombre: 'Ana', motivo: 'Cotización',
      },
    })
    expect(out).toContain('Cita agendada')
    expect(cal.agendar_cita).toHaveBeenCalledWith({
      db: mockDb, accountId: 'acct', contactoId: 'contact-9',
      inicio: '2026-09-14T10:00:00-05:00', nombre: 'Ana', motivo: 'Cotización',
    })
  })

  it('returns error for agendar_cita when inicio is missing', async () => {
    const out = await executeToolCall(mockDb, 'a', 'c', {
      id: '4', name: 'agendar_cita', arguments: { nombre: 'Ana' },
    })
    expect(out).toContain('Error')
  })

  it('forwards the contact id to reagendar_cita so it can resolve the cita itself', async () => {
    const out = await executeToolCall(mockDb, 'a', 'contact-9', {
      id: '5', name: 'reagendar_cita', arguments: { idCita: 'c-1', nuevoInicio: '2026-09-15T11:00:00-05:00' },
    })
    expect(out).toContain('Cita reagendada')
    expect(cal.reagendar_cita).toHaveBeenCalledWith({
      db: mockDb, accountId: 'a', contactId: 'contact-9',
      idCita: 'c-1', nuevoInicio: '2026-09-15T11:00:00-05:00',
    })
  })

  it('resolves the active cita when the model omits idCita', async () => {
    // The duplicate-event bug: without this, a model that could not recall
    // the UUID had no move path left and reached for agendar_cita instead.
    const out = await executeToolCall(mockDb, 'a', 'contact-9', {
      id: '5b', name: 'reagendar_cita', arguments: { nuevoInicio: '2026-09-15T11:00:00-05:00' },
    })
    expect(out).toContain('Cita reagendada')
    expect(cal.reagendar_cita).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: 'contact-9', idCita: undefined })
    )
  })

  it('returns error for reagendar_cita when nuevoInicio is missing', async () => {
    const out = await executeToolCall(mockDb, 'a', 'c', {
      id: '5c', name: 'reagendar_cita', arguments: { idCita: 'c-1' },
    })
    expect(out).toContain('Error')
    expect(cal.reagendar_cita).not.toHaveBeenCalled()
  })

  it('dispatches consultar_citas against the current contact', async () => {
    const out = await executeToolCall(mockDb, 'a', 'contact-9', {
      id: '5d', name: 'consultar_citas', arguments: {},
    })
    expect(out).toContain('idCita')
    expect(cal.consultar_citas).toHaveBeenCalledWith({
      db: mockDb, accountId: 'a', contactId: 'contact-9',
    })
  })

  it('calls cancelar_cita with the contact so it can resolve the cita itself', async () => {
    const out = await executeToolCall(mockDb, 'a', 'contact-9', {
      id: '6', name: 'cancelar_cita', arguments: { idCita: 'c-1' },
    })
    expect(out).toContain('Cita cancelada')
    expect(cal.cancelar_cita).toHaveBeenCalledWith({
      db: mockDb, accountId: 'a', contactId: 'contact-9', idCita: 'c-1',
    })
  })

  it('calls listar_eventos with default maxResults', async () => {
    const out = await executeToolCall(mockDb, 'a', 'c', {
      id: '7', name: 'listar_eventos', arguments: { desde: '2026-09-20' },
    })
    expect(out).toContain('Cita')
    expect(cal.listar_eventos).toHaveBeenCalledWith({ desde: '2026-09-20', hasta: undefined, maxResults: undefined })
  })

  it('calls enviar_correo with an HTML body', async () => {
    const out = await executeToolCall(mockDb, 'a', 'c', {
      id: '8', name: 'enviar_correo', arguments: { to: 'ana@x.com', subject: 'Confirmación', body: '<strong>Cita</strong>' },
    })
    expect(out).toContain('Correo enviado')
    expect(gmailModule.enviar_correo).toHaveBeenCalledWith({ to: 'ana@x.com', subject: 'Confirmación', html: '<strong>Cita</strong>' })
  })

  it('returns error for enviar_correo when fields are missing', async () => {
    const out = await executeToolCall(mockDb, 'a', 'c', {
      id: '9', name: 'enviar_correo', arguments: { to: 'ana@x.com' },
    })
    expect(out).toContain('Error')
    expect(gmailModule.enviar_correo).not.toHaveBeenCalled()
  })

  it('calls leer_correos', async () => {
    const out = await executeToolCall(mockDb, 'a', 'c', {
      id: '10', name: 'leer_correos', arguments: { maxResults: 100, query: 'is:unread' },
    })
    expect(out).toContain('De: ana@x.com')
    expect(gmailModule.leer_correos).toHaveBeenCalledWith({ maxResults: 100, query: 'is:unread' })
  })

  it('returns unknown tool for unrecognized name', async () => {
    const out = await executeToolCall(mockDb, 'a', 'c', {
      id: '11', name: 'magic_wand', arguments: {},
    })
    expect(out).toContain('Herramienta desconocida')
  })
})

describe('update_client_profile handler', () => {
  it('returns no data message when no known fields present', async () => {
    const out = await executeToolCall(mockDb, 'a', 'c', {
      id: '8', name: 'update_client_profile', arguments: { something_else: 'x' },
    })
    expect(out).toContain('No hay datos de perfil para actualizar')
  })
})