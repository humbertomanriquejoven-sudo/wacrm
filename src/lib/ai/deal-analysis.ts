import type { SupabaseClient } from '@supabase/supabase-js'
import type { PipelineStage } from '@/types'
import type { AiConfig, ChatMessage } from './types'
import { generateReply } from './generate'
import { logAiUsage } from './usage'
import {
  EVALUATE_LEAD_TOOL,
  buildAiNotesBlock,
  findStageByName,
  mergeAiNotes,
  parseDealEvaluation,
} from './deal-scoring'

// ============================================================
// AI lead scoring + automatic pipeline movement.
//
// Runs AFTER a successful WhatsApp reply has been dispatched. It is
// best-effort: every failure is logged and swallowed so it can never
// affect the customer reply. The model is FORCED (toolChoice) to call
// `evaluate_lead`, so its structured analysis is returned as a tool
// call and persisted — never written into the WhatsApp outbound.
//
// Rules enforced here:
//   * no duplicate ACTIVE deals per contact (application-level dedupe:
//     reuse the open deal when one exists, create otherwise);
//   * the mapped stage must belong to the chosen pipeline (only that
//     pipeline's stages are searched);
//   * manual notes are never overwritten (fenced AI block via
//     `mergeAiNotes`), and dedicated `ai_*` columns carry the data.
// ============================================================

const TRANSCRIPT_MAX_MESSAGES = 20
const TRANSCRIPT_MAX_CHARS = 600

export interface AnalyzeDealArgs {
  db: SupabaseClient
  accountId: string
  /** Owner id used for `deals.user_id` (NOT NULL) on create. */
  userId: string
  conversationId: string
  contactId: string
  config: AiConfig
  /** Conversation transcript (oldest first) already loaded for the reply. */
  messages: ChatMessage[]
  contactName?: string | null
  /** Prefer a specific pipeline (e.g. the deal's own); else the account's first. */
  pipelineId?: string | null
}

interface ActiveDealRow {
  id: string
  stage_id: string
  status: string
  notes: string | null
}

async function pickPipeline(
  db: SupabaseClient,
  accountId: string,
  preferredId: string | null,
): Promise<string | null> {
  if (preferredId) {
    const { data } = await db
      .from('pipelines')
      .select('id')
      .eq('id', preferredId)
      .eq('account_id', accountId)
      .maybeSingle()
    const id = (data as { id?: string } | null)?.id
    if (id) return id
  }
  const { data } = await db
    .from('pipelines')
    .select('id')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  return (data as { id?: string } | null)?.id ?? null
}

async function loadStages(
  db: SupabaseClient,
  pipelineId: string,
): Promise<PipelineStage[]> {
  const { data } = await db
    .from('pipeline_stages')
    .select('id, pipeline_id, name, position, color, created_at')
    .eq('pipeline_id', pipelineId)
    .order('position', { ascending: true })
  return (data ?? []) as PipelineStage[]
}

function truncate(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

function buildTranscript(messages: ChatMessage[]): string {
  return messages
    .slice(-TRANSCRIPT_MAX_MESSAGES)
    .map((m) => {
      const who =
        m.role === 'user' ? 'CLIENTE' : m.role === 'tool' ? 'SISTEMA' : 'NEGOCIO'
      return `${who}: ${truncate(m.content, TRANSCRIPT_MAX_CHARS)}`
    })
    .join('\n')
}

function buildEvaluationPrompt(
  stages: PipelineStage[],
  contactName?: string | null,
): string {
  const stageList = stages.map((s, i) => `${i + 1}. ${s.name}`).join('\n')
  return [
    'Eres un analista comercial experto de un CRM de ventas por WhatsApp. ' +
      'Evalúa la intención de compra del prospecto a partir del historial de la conversación.',
    contactName ? `Cliente: ${contactName}` : null,
    `Etapas del embudo — elige EXACTAMENTE una por su nombre, tal cual aparece:\n${stageList}`,
    'Llama a la herramienta evaluate_lead exactamente UNA vez con tu evaluación. ' +
      'No respondas con texto libre.',
  ]
    .filter((p): p is string => Boolean(p))
    .join('\n\n')
}

async function defaultCurrency(
  db: SupabaseClient,
  accountId: string,
): Promise<string> {
  const { data } = await db
    .from('accounts')
    .select('default_currency')
    .eq('id', accountId)
    .maybeSingle()
  const value = (data as { default_currency?: string } | null)?.default_currency
  return typeof value === 'string' && value.trim() ? value : 'USD'
}

/**
 * The contact's single ACTIVE (open) deal in this pipeline, if any.
 * Oldest first so a legacy duplicate pair collapses onto the original.
 */
async function findActiveDeal(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  pipelineId: string,
): Promise<ActiveDealRow | null> {
  const { data, error } = await db
    .from('deals')
    .select('id, stage_id, status, notes')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('pipeline_id', pipelineId)
    .eq('status', 'open')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) return null
  return (data as ActiveDealRow | null) ?? null
}

/**
 * Score the conversation and move the contact's active deal. NEVER
 * throws and never touches WhatsApp — safe to `await` inside the
 * webhook's `after()` lifetime without risking the customer reply.
 */
export async function analyzeDealFromConversation(
  args: AnalyzeDealArgs,
): Promise<void> {
  const { db, accountId, contactId, conversationId, config, messages } = args

  try {
    if (!messages || messages.length === 0) return

    const pipelineId = await pickPipeline(
      db,
      accountId,
      args.pipelineId ?? null,
    )
    if (!pipelineId) return

    const stages = await loadStages(db, pipelineId)
    if (stages.length === 0) return

    const transcript = buildTranscript(messages)
    if (!transcript.trim()) return

    const result = await generateReply({
      config,
      systemPrompt: buildEvaluationPrompt(stages, args.contactName),
      messages: [
        {
          role: 'user',
          content: `Historial de la conversación:\n${transcript}`,
        },
      ],
      tools: [EVALUATE_LEAD_TOOL],
      // FORCE the structured tool so the analysis can never be narrated
      // into free text (which could leak toward the customer).
      toolChoice: {
        type: 'function',
        function: { name: EVALUATE_LEAD_TOOL.name },
      },
    })

    const call = result.toolCalls?.find(
      (tc) => tc.name === EVALUATE_LEAD_TOOL.name,
    )
    const evaluation = parseDealEvaluation(call?.arguments)
    if (!evaluation) return

    // Validate the mapped stage belongs to the CHOSEN pipeline. `stages`
    // only contains this pipeline's rows, so an unknown name → null and
    // the move is skipped (the current stage is kept).
    const mappedStage = findStageByName(stages, evaluation.stageName)

    const existing = await findActiveDeal(
      db,
      accountId,
      contactId,
      pipelineId,
    )

    let dealId: string
    let currentStageId: string
    let existingNotes: string | null

    if (existing) {
      dealId = existing.id
      currentStageId = existing.stage_id
      existingNotes = existing.notes
    } else {
      const initialStage = mappedStage ?? stages[0]
      const { data, error } = await db
        .from('deals')
        .insert({
          account_id: accountId,
          user_id: args.userId,
          pipeline_id: pipelineId,
          stage_id: initialStage.id,
          contact_id: contactId,
          conversation_id: conversationId,
          title: (args.contactName?.trim() || 'Nuevo lead').slice(0, 200),
          value: 0,
          currency: await defaultCurrency(db, accountId),
          status: 'open',
        })
        .select('id, stage_id, notes')
        .maybeSingle()
      if (error || !data) {
        console.error(
          '[ai deal-analysis] could not create the deal:',
          error?.message ?? 'no row returned',
        )
        return
      }
      const created = data as ActiveDealRow
      dealId = created.id
      currentStageId = created.stage_id
      existingNotes = created.notes ?? null
    }

    const nextStageId = mappedStage?.id ?? currentStageId
    const notes = mergeAiNotes(existingNotes, buildAiNotesBlock(evaluation))

    const { error: updateErr } = await db
      .from('deals')
      .update({
        stage_id: nextStageId,
        notes,
        ai_score: evaluation.score,
        ai_temperature: evaluation.temperature,
        ai_summary: evaluation.summary,
        ai_stage_id: mappedStage?.id ?? null,
        ai_analyzed_at: new Date().toISOString(),
        ai_analysis_model: config.model,
        updated_at: new Date().toISOString(),
      })
      .eq('id', dealId)
      .eq('account_id', accountId)

    if (updateErr) {
      console.error(
        '[ai deal-analysis] could not persist the evaluation:',
        updateErr.message,
      )
    }

    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'deal_analysis',
      provider: config.provider,
      model: config.model,
      usage: result.usage,
    })
  } catch (err) {
    console.error(
      '[ai deal-analysis] failed:',
      err instanceof Error ? err.message : err,
    )
  }
}
