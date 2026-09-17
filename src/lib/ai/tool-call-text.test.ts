import { describe, it, expect } from 'vitest'
import { extractLeakedToolCalls, parseInvocationArgs } from './tool-call-text'

const TOOLS = ['ver_disponibilidad', 'agendar_cita', 'reagendar_cita', 'cancelar_cita']

describe('extractLeakedToolCalls', () => {
  it('strips a Gemini "step_0: print(default_api.…)" line and recovers the call', () => {
    const raw =
      'step_0: print(default_api.ver_disponibilidad(desde="2026-09-17", hasta="2026-09-17"))'
    const { text, toolCalls } = extractLeakedToolCalls(raw, TOOLS)
    expect(text).toBe('')
    expect(toolCalls).toEqual([
      {
        id: 'text-call-ver_disponibilidad-0',
        name: 'ver_disponibilidad',
        arguments: { desde: '2026-09-17', hasta: '2026-09-17' },
      },
    ])
  })

  it('recovers a bare default_api.agendar_cita invocation', () => {
    const raw =
      'default_api.agendar_cita(inicio="2026-09-18T14:00:00-05:00", nombre="Carlos Pérez", motivo="cotización")'
    const { text, toolCalls } = extractLeakedToolCalls(raw, TOOLS)
    expect(text).toBe('')
    expect(toolCalls[0].name).toBe('agendar_cita')
    expect(toolCalls[0].arguments).toEqual({
      inicio: '2026-09-18T14:00:00-05:00',
      nombre: 'Carlos Pérez',
      motivo: 'cotización',
    })
  })

  it('keeps the customer-facing text and drops only the scaffolding line', () => {
    const raw =
      'Déjame revisar la agenda.\nstep_0: print(default_api.ver_disponibilidad(desde="2026-09-17", hasta="2026-09-17"))\nUn momento, por favor.'
    const { text, toolCalls } = extractLeakedToolCalls(raw, TOOLS)
    expect(text).toContain('Déjame revisar la agenda.')
    expect(text).toContain('Un momento, por favor.')
    expect(text).not.toContain('step_0')
    expect(text).not.toContain('default_api')
    expect(toolCalls).toHaveLength(1)
  })

  it('accepts a JSON-object argument form', () => {
    const raw = 'default_api.cancelar_cita({"idCita": "abc-123"})'
    const { toolCalls } = extractLeakedToolCalls(raw, TOOLS)
    expect(toolCalls[0].arguments).toEqual({ idCita: 'abc-123' })
  })

  it('leaves a clean line untouched and drops an unknown default_api line', () => {
    const raw =
      'Puedes usar print(hola) en tu código.\ndefault_api.otra_cosa(x="1")'
    const { text, toolCalls } = extractLeakedToolCalls(raw, TOOLS)
    expect(text).toBe('Puedes usar print(hola) en tu código.')
    expect(toolCalls).toEqual([])
  })

  it('removes default_api/step scaffolding even without known tool names', () => {
    const raw = 'step_0: print(default_api.otra_cosa(x="1"))'
    const { text, toolCalls } = extractLeakedToolCalls(raw, [])
    expect(text).toBe('')
    expect(toolCalls).toEqual([])
  })

  it('recovers multiple leaked calls on separate lines', () => {
    const raw =
      'default_api.ver_disponibilidad(desde="2026-09-17", hasta="2026-09-18")\n' +
      'default_api.agendar_cita(inicio="2026-09-18T14:00:00-05:00", nombre="Ana")'
    const { toolCalls } = extractLeakedToolCalls(raw, TOOLS)
    expect(toolCalls.map((t) => t.name)).toEqual(['ver_disponibilidad', 'agendar_cita'])
  })
})

describe('parseInvocationArgs', () => {
  it('parses python kwargs with single and double quotes', () => {
    expect(parseInvocationArgs(`desde='2026-09-17', nombre="Ana"`)).toEqual({
      desde: '2026-09-17',
      nombre: 'Ana',
    })
  })

  it('parses a JSON object', () => {
    expect(parseInvocationArgs('{"idCita": "x", "n": 1}')).toEqual({
      idCita: 'x',
      n: 1,
    })
  })

  it('returns an empty object for empty input', () => {
    expect(parseInvocationArgs('')).toEqual({})
  })
})
