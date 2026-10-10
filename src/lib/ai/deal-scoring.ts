import type { PipelineStage } from '@/types'
import type { ToolDefinition } from './types'

// ============================================================
// Pure helpers + tool schema for AI lead scoring.
//
// The LLM is forced to call `evaluate_lead` so its structured analysis
// NEVER reaches WhatsApp: the adapter returns it as a tool call, the
// orchestrator (`deal-analysis.ts`) persists it, and the customer only
// ever sees the ordinary text reply. Everything here is deterministic
// and side-effect free so it is cheap to unit-test.
// ============================================================

/** Delimiters bracketing the AI block inside `deals.notes`. */
export const AI_NOTES_START = '<!-- AI:COMMERCIAL v1 -->'
export const AI_NOTES_END = '<!-- /AI:COMMERCIAL -->'

export const AI_SCORE_MIN = 0
export const AI_SCORE_MAX = 10

export type DealTemperature = 'hot' | 'warm' | 'cold'

/** Normalized evaluation extracted from the forced tool call. */
export interface DealEvaluation {
  score: number
  /** Stage NAME the model chose (validated against the pipeline later). */
  stageName: string | null
  temperature: DealTemperature | null
  summary: string
  buyingSignals: string[]
  objections: string[]
}

/**
 * Tool the model is FORCED to call. `score` is the 0-10 lead score; the
 * enum on `temperature` keeps the value from drifting into free text.
 */
export const EVALUATE_LEAD_TOOL: ToolDefinition = {
  name: 'evaluate_lead',
  description:
    'Registra la evaluación comercial del prospecto a partir de la conversación: ' +
    'puntaje de 0 a 10, temperatura (hot/warm/cold), etapa sugerida del embudo, ' +
    'un resumen breve, señales de compra y objeciones. Llámala SIEMPRE y UNA sola vez.',
  parameters: {
    type: 'object',
    properties: {
      score: {
        type: 'integer',
        description:
          'Puntaje de intención de compra de 0 (sin interés) a 10 (listo para comprar).',
      },
      stage: {
        type: 'string',
        description:
          'Nombre EXACTO de una de las etapas disponibles del embudo entregadas en el prompt.',
      },
      temperature: {
        type: 'string',
        enum: ['hot', 'warm', 'cold'],
        description:
          'hot = compra inminente; warm = interesado pero sin decisión; cold = solo explorando.',
      },
      summary: {
        type: 'string',
        description: 'Resumen de una o dos frases sobre el estado comercial del prospecto.',
      },
      buying_signals: {
        type: 'string',
        description:
          'Señales de compra detectadas, separadas por punto y coma (p. ej. "pidió precio; propuso fecha").',
      },
      objections: {
        type: 'string',
        description:
          'Objeciones o bloqueos detectados, separados por punto y coma (vacío si no hay).',
      },
    },
    required: ['score', 'stage', 'summary'],
  },
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Coerce a value into a 0-10 integer score, or null when it is not a
 * finite number. Out-of-range values are clamped rather than rejected —
 * a model returning 12 still yields a usable 10.
 */
export function clampScore(value: unknown): number | null {
  // Guard the explicit empties: Number(null) and Number('') are 0, which
  // would silently score a missing value as the minimum.
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return null
  return Math.min(AI_SCORE_MAX, Math.max(AI_SCORE_MIN, Math.round(n)))
}

function parseTemperature(value: unknown): DealTemperature | null {
  const raw = asText(value).toLowerCase()
  if (raw === 'hot' || raw === 'caliente') return 'hot'
  if (raw === 'warm' || raw === 'tibio') return 'warm'
  if (raw === 'cold' || raw === 'frio' || raw === 'frío') return 'cold'
  return null
}

/** Accept an array or a delimited string and normalize to a clean list. */
export function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter((v) => v.length > 0)
  }
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/[\n;,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }
  return []
}

/**
 * Accent/case/punctuation-insensitive key, so "Proposal Sent",
 * "propuesta enviada" and "Propuesta-enviada" all collapse the same
 * way for matching model output to a real stage name.
 */
export function normalizeStageName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Map the model's stage name to a stage of the CHOSEN pipeline.
 *
 * Only the provided `stages` are searched, which is exactly how "the
 * mapped stage must belong to the chosen pipeline" is enforced: a
 * hallucinated name that matches nothing (or a stage from another
 * pipeline) resolves to null and no move is applied. Falls back from an
 * exact normalized match to substring containment.
 */
export function findStageByName(
  stages: PipelineStage[],
  name: string | null | undefined,
): PipelineStage | null {
  const raw = asText(name)
  if (!raw) return null
  const target = normalizeStageName(raw)
  if (!target) return null

  const exact = stages.find((s) => normalizeStageName(s.name) === target)
  if (exact) return exact

  return (
    stages.find((s) => {
      const candidate = normalizeStageName(s.name)
      return (
        candidate.length > 0 &&
        (candidate.includes(target) || target.includes(candidate))
      )
    }) ?? null
  )
}

/**
 * Read a forced `evaluate_lead` tool call's arguments into a typed
 * evaluation. Returns null when there is no usable score — the one
 * field a scoring pass cannot do without.
 */
export function parseDealEvaluation(
  args: Record<string, unknown> | null | undefined,
): DealEvaluation | null {
  if (!args || typeof args !== 'object') return null
  const score = clampScore(args.score)
  if (score === null) return null
  return {
    score,
    stageName: asText(args.stage) || null,
    temperature: parseTemperature(args.temperature),
    summary: asText(args.summary),
    buyingSignals: toStringList(args.buying_signals),
    objections: toStringList(args.objections),
  }
}

/**
 * Render the human-readable AI block written into `deals.notes`. It is
 * fenced by explicit delimiters so `mergeAiNotes` can replace ONLY this
 * block on the next pass and never touch a person's own notes.
 */
export function buildAiNotesBlock(
  evaluation: DealEvaluation,
  now: Date = new Date(),
): string {
  const lines: string[] = [AI_NOTES_START, `Puntaje: ${evaluation.score}/10`]
  if (evaluation.temperature) lines.push(`Temperatura: ${evaluation.temperature}`)
  if (evaluation.stageName) lines.push(`Etapa sugerida: ${evaluation.stageName}`)
  if (evaluation.summary) lines.push(`Resumen: ${evaluation.summary}`)
  if (evaluation.buyingSignals.length > 0) {
    lines.push(`Señales de compra: ${evaluation.buyingSignals.join('; ')}`)
  }
  if (evaluation.objections.length > 0) {
    lines.push(`Objeciones: ${evaluation.objections.join('; ')}`)
  }
  lines.push(`Actualizado: ${now.toISOString()}`)
  lines.push(AI_NOTES_END)
  return lines.join('\n')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const AI_BLOCK_RE = new RegExp(
  `${escapeRegExp(AI_NOTES_START)}[\\s\\S]*?${escapeRegExp(AI_NOTES_END)}`,
  'g',
)

/**
 * Merge a fresh AI block into existing notes WITHOUT ever discarding
 * manual text: any previous AI block is removed, the human's notes are
 * preserved verbatim, and the new block is appended after them.
 */
export function mergeAiNotes(
  existing: string | null | undefined,
  block: string,
): string {
  const manual = (existing ?? '').replace(AI_BLOCK_RE, '').trim()
  return manual ? `${manual}\n\n${block}` : block
}
