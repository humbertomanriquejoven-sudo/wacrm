import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/calendar', () => ({
  calendarConfigured: vi.fn(() => true),
  ver_disponibilidad: vi.fn(async () => 'horarios libres: L 09:00'),
  agendar_cita: vi.fn(async () => 'Cita agendada'),
  reagendar_cita: vi.fn(async () => 'Cita reagendada'),
  cancelar_cita: vi.fn(async () => 'Cita cancelada'),
}))

import { executeToolCall, AI_TOOLS, VER_DISPONIBILIDAD_TOOL, AGENDAR_CITA_TOOL, REAGENDAR_CITA_TOOL, CANCELAR_CITA_TOOL } from './tools'
import * as cal from '@/lib/calendar'

const mockDb = {} as never

describe('AI_TOOLS array', () => {
  it('contains the 5 expected tools', () => {
    expect(AI_TOOLS.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'update_client_profile',
        'ver_disponibilidad',
        'agendar_cita',
        'reagendar_cita',
        'cancelar_cita',
      ]),
    )
    expect(AI_TOOLS).toHaveLength(5)
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
  it('reagendar_cita requires idCita and nuevoInicio', () => {
    expect(REAGENDAR_CITA_TOOL.parameters.required).toEqual(['idCita', 'nuevoInicio'])
  })
  it('cancelar_cita requires idCita', () => {
    expect(CANCELAR_CITA_TOOL.parameters.required).toEqual(['idCita'])
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

  it('calls reagendar_cita', async () => {
    const out = await executeToolCall(mockDb, 'a', 'c', {
      id: '5', name: 'reagendar_cita', arguments: { idCita: 'c-1', nuevoInicio: '2026-09-15T11:00:00-05:00' },
    })
    expect(out).toContain('Cita reagendada')
    expect(cal.reagendar_cita).toHaveBeenCalledWith({ db: mockDb, accountId: 'a', idCita: 'c-1', nuevoInicio: '2026-09-15T11:00:00-05:00' })
  })

  it('calls cancelar_cita', async () => {
    const out = await executeToolCall(mockDb, 'a', 'c', {
      id: '6', name: 'cancelar_cita', arguments: { idCita: 'c-1' },
    })
    expect(out).toContain('Cita cancelada')
    expect(cal.cancelar_cita).toHaveBeenCalledWith({ db: mockDb, accountId: 'a', idCita: 'c-1' })
  })

  it('returns unknown tool for unrecognized name', async () => {
    const out = await executeToolCall(mockDb, 'a', 'c', {
      id: '7', name: 'magic_wand', arguments: {},
    })
    expect(out).toContain('Unknown tool')
  })
})

describe('update_client_profile handler', () => {
  it('returns no data message when no known fields present', async () => {
    const out = await executeToolCall(mockDb, 'a', 'c', {
      id: '8', name: 'update_client_profile', arguments: { something_else: 'x' },
    })
    expect(out).toContain('No profile data to update')
  })
})