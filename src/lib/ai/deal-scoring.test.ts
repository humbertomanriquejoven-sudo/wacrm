import { describe, expect, it } from 'vitest'
import type { PipelineStage } from '@/types'
import {
  AI_NOTES_END,
  AI_NOTES_START,
  buildAiNotesBlock,
  clampScore,
  findStageByName,
  mergeAiNotes,
  normalizeStageName,
  parseDealEvaluation,
  toStringList,
} from './deal-scoring'

function stage(name: string, id = name, pipelineId = 'pipe-1'): PipelineStage {
  return {
    id,
    pipeline_id: pipelineId,
    name,
    position: 0,
    color: '#000000',
    created_at: '',
  }
}

describe('clampScore', () => {
  it('rounds and clamps to 0-10', () => {
    expect(clampScore(5.4)).toBe(5)
    expect(clampScore(-3)).toBe(0)
    expect(clampScore(12)).toBe(10)
    expect(clampScore('7')).toBe(7)
  })

  it('returns null for non-numeric input', () => {
    expect(clampScore('hot')).toBeNull()
    expect(clampScore(null)).toBeNull()
    expect(clampScore(undefined)).toBeNull()
    expect(clampScore(Number.NaN)).toBeNull()
  })
})

describe('toStringList', () => {
  it('trims arrays and drops empties', () => {
    expect(toStringList([' a ', '', 'b'])).toEqual(['a', 'b'])
  })

  it('splits delimited strings', () => {
    expect(toStringList('a; b, c\nd')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('returns an empty list for junk', () => {
    expect(toStringList(42)).toEqual([])
    expect(toStringList('   ')).toEqual([])
  })
})

describe('normalizeStageName', () => {
  it('is accent/case/punctuation insensitive', () => {
    expect(normalizeStageName('Propuesta Enviada')).toBe('propuesta enviada')
    expect(normalizeStageName('Propuesta-enviada')).toBe('propuesta enviada')
    expect(normalizeStageName('CUALIFICACIÓN')).toBe('cualificacion')
  })
})

describe('findStageByName', () => {
  const stages = [stage('New Lead'), stage('Qualified'), stage('Proposal Sent')]

  it('matches exactly (case/accent insensitive)', () => {
    expect(findStageByName(stages, 'qualified')?.name).toBe('Qualified')
    expect(findStageByName(stages, 'PROPOSAL SENT')?.name).toBe('Proposal Sent')
  })

  it('falls back to containment', () => {
    expect(findStageByName(stages, 'proposal')?.name).toBe('Proposal Sent')
    expect(findStageByName(stages, 'new lead stage')?.name).toBe('New Lead')
  })

  it('returns null for an unknown stage (not in this pipeline)', () => {
    expect(findStageByName(stages, 'Closed Won')).toBeNull()
    expect(findStageByName(stages, '')).toBeNull()
    expect(findStageByName(stages, null)).toBeNull()
  })
})

describe('parseDealEvaluation', () => {
  it('maps a full tool-call argument object', () => {
    const evaluation = parseDealEvaluation({
      score: 8,
      stage: 'Qualified',
      temperature: 'hot',
      summary: 'Listo para cotizar',
      buying_signals: 'pidió precio; propuso fecha',
      objections: 'presupuesto',
    })
    expect(evaluation).toEqual({
      score: 8,
      stageName: 'Qualified',
      temperature: 'hot',
      summary: 'Listo para cotizar',
      buyingSignals: ['pidió precio', 'propuso fecha'],
      objections: ['presupuesto'],
    })
  })

  it('requires a usable score', () => {
    expect(parseDealEvaluation({ stage: 'Qualified' })).toBeNull()
    expect(parseDealEvaluation({ score: 'oops' })).toBeNull()
    expect(parseDealEvaluation(null)).toBeNull()
  })

  it('normalizes Spanish temperature synonyms', () => {
    expect(parseDealEvaluation({ score: 5, temperature: 'tibio' })?.temperature).toBe('warm')
    expect(parseDealEvaluation({ score: 5, temperature: 'frío' })?.temperature).toBe('cold')
    expect(parseDealEvaluation({ score: 5, temperature: 'nope' })?.temperature).toBeNull()
  })
})

describe('buildAiNotesBlock', () => {
  it('fences the block and includes the score + summary', () => {
    const block = buildAiNotesBlock(
      {
        score: 7,
        stageName: 'Negotiation',
        temperature: 'warm',
        summary: 'Comparando opciones',
        buyingSignals: ['usa el producto'],
        objections: [],
      },
      new Date('2026-01-02T03:04:05.000Z'),
    )
    expect(block.startsWith(AI_NOTES_START)).toBe(true)
    expect(block.trimEnd().endsWith(AI_NOTES_END)).toBe(true)
    expect(block).toContain('Puntaje: 7/10')
    expect(block).toContain('Etapa sugerida: Negotiation')
    expect(block).toContain('Resumen: Comparando opciones')
    expect(block).not.toContain('Objeciones')
    expect(block).toContain('2026-01-02T03:04:05.000Z')
  })
})

describe('mergeAiNotes', () => {
  const block = `${AI_NOTES_START}\nPuntaje: 9/10\n${AI_NOTES_END}`

  it('keeps human notes and appends the block', () => {
    const merged = mergeAiNotes('Manual: cliente referido', block)
    expect(merged.startsWith('Manual: cliente referido')).toBe(true)
    expect(merged).toContain(block)
  })

  it('replaces a previous AI block without touching manual text', () => {
    const previous = `Manual note\n\n${AI_NOTES_START}\nPuntaje: 2/10\n${AI_NOTES_END}`
    const merged = mergeAiNotes(previous, block)
    expect(merged).toContain('Manual note')
    expect(merged).not.toContain('Puntaje: 2/10')
    expect(merged).toContain('Puntaje: 9/10')
  })

  it('returns just the block when there are no notes', () => {
    expect(mergeAiNotes(null, block)).toBe(block)
    expect(mergeAiNotes('', block)).toBe(block)
  })
})
