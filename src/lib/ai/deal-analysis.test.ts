import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig, ChatMessage } from './types'
import type { PipelineStage } from '@/types'

const h = vi.hoisted(() => ({
  generateReply: vi.fn(),
  logAiUsage: vi.fn(),
  pipeline: { id: 'pipe-1' } as { id: string } | null,
  stages: [] as PipelineStage[],
  existingDeal: null as {
    id: string
    stage_id: string
    status: string
    notes: string | null
  } | null,
  currency: 'USD',
  createdDeal: {
    id: 'deal-new',
    stage_id: 'stage-a',
    notes: null,
  } as { id: string; stage_id: string; notes: string | null },
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
}))

vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('./usage', () => ({ logAiUsage: h.logAiUsage }))

import { analyzeDealFromConversation } from './deal-analysis'

function stage(name: string, id: string): PipelineStage {
  return {
    id,
    pipeline_id: 'pipe-1',
    name,
    position: 0,
    color: '#000000',
    created_at: '',
  }
}

/**
 * Minimal thenable Supabase query-builder stand-in. Every chain method is
 * a no-op that returns the builder; awaiting resolves list-shaped reads,
 * and `.maybeSingle()`/`.single()` resolve single-row reads. Mutations
 * are recorded so assertions can inspect the payload.
 */
function makeDb(): SupabaseClient {
  const builderFor = (table: string) => {
    let didInsert = false
    const builder: Record<string, unknown> = {}
    const chain = (name: string) => (arg: unknown) => {
      if (name === 'insert') {
        didInsert = true
        h.inserts.push(arg as Record<string, unknown>)
      }
      if (name === 'update') {
        h.updates.push(arg as Record<string, unknown>)
      }
      return builder
    }
    for (const m of [
      'select',
      'eq',
      'order',
      'limit',
      'not',
      'in',
      'insert',
      'update',
      'upsert',
      'delete',
    ]) {
      builder[m] = chain(m)
    }
    const single = () => {
      if (table === 'pipelines') return Promise.resolve({ data: h.pipeline, error: null })
      if (table === 'pipeline_stages')
        return Promise.resolve({ data: h.stages, error: null })
      if (table === 'accounts')
        return Promise.resolve({ data: { default_currency: h.currency }, error: null })
      if (table === 'deals') {
        return Promise.resolve({
          data: didInsert ? h.createdDeal : h.existingDeal,
          error: null,
        })
      }
      return Promise.resolve({ data: null, error: null })
    }
    builder.maybeSingle = single
    builder.single = single
    builder.then = (onFulfilled: (v: unknown) => unknown) => {
      const listData = table === 'pipeline_stages' ? h.stages : []
      return Promise.resolve({ data: listData, error: null }).then(onFulfilled)
    }
    return builder
  }
  return { from: (table: string) => builderFor(table) } as unknown as SupabaseClient
}

function aiConfig(): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
  }
}

const MESSAGES: ChatMessage[] = [
  { role: 'user', content: 'Hola, quiero cotizar el plan pro' },
  { role: 'assistant', content: 'Claro, ¿cuántos usuarios necesitas?' },
  { role: 'user', content: 'Unos 20. ¿Cuánto cuesta?' },
]

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    db: makeDb(),
    accountId: 'acct-1',
    userId: 'user-1',
    conversationId: 'conv-1',
    contactId: 'contact-1',
    config: aiConfig(),
    messages: MESSAGES,
    contactName: 'Carlos',
    ...overrides,
  }
}

beforeEach(() => {
  h.generateReply.mockReset()
  h.logAiUsage.mockReset()
  h.inserts = []
  h.updates = []
  h.pipeline = { id: 'pipe-1' }
  h.stages = [
    stage('New Lead', 'stage-a'),
    stage('Qualified', 'stage-b'),
    stage('Proposal Sent', 'stage-c'),
  ]
  h.existingDeal = null
  h.currency = 'USD'
  h.generateReply.mockResolvedValue({
    text: '',
    handoff: false,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    toolCalls: [
      {
        id: 't1',
        name: 'evaluate_lead',
        arguments: {
          score: 8,
          stage: 'Qualified',
          temperature: 'hot',
          summary: 'Listo para cotizar',
          buying_signals: 'pidió precio; propuso fecha',
          objections: 'presupuesto',
        },
      },
    ],
  })
})

describe('analyzeDealFromConversation', () => {
  it('forces the evaluate_lead tool call', async () => {
    await analyzeDealFromConversation(baseArgs())
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    const arg = h.generateReply.mock.calls[0][0]
    expect(arg.tools.map((t: { name: string }) => t.name)).toContain('evaluate_lead')
    expect(arg.toolChoice).toEqual({
      type: 'function',
      function: { name: 'evaluate_lead' },
    })
  })

  it('creates an active deal and persists the score when none exists', async () => {
    await analyzeDealFromConversation(baseArgs())

    expect(h.inserts).toHaveLength(1)
    expect(h.inserts[0]).toMatchObject({
      account_id: 'acct-1',
      user_id: 'user-1',
      pipeline_id: 'pipe-1',
      stage_id: 'stage-b',
      contact_id: 'contact-1',
      conversation_id: 'conv-1',
      status: 'open',
      currency: 'USD',
    })

    expect(h.updates).toHaveLength(1)
    expect(h.updates[0]).toMatchObject({
      stage_id: 'stage-b',
      ai_score: 8,
      ai_temperature: 'hot',
      ai_stage_id: 'stage-b',
      ai_summary: 'Listo para cotizar',
      ai_analysis_model: 'gpt-test',
    })
    expect(h.updates[0].notes).toContain('Puntaje: 8/10')

    expect(h.logAiUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: 'deal_analysis', accountId: 'acct-1' }),
    )
  })

  it('reuses the existing open deal (no duplicate) and preserves manual notes', async () => {
    h.existingDeal = {
      id: 'deal-1',
      stage_id: 'stage-a',
      status: 'open',
      notes: 'Manual: cliente referido',
    }
    await analyzeDealFromConversation(baseArgs())

    expect(h.inserts).toHaveLength(0)
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].notes).toContain('Manual: cliente referido')
    expect(h.updates[0].notes).toContain('Puntaje: 8/10')
  })

  it('keeps the current stage when the model names an unknown stage', async () => {
    h.existingDeal = {
      id: 'deal-1',
      stage_id: 'stage-a',
      status: 'open',
      notes: null,
    }
    h.generateReply.mockResolvedValue({
      text: '',
      handoff: false,
      usage: null,
      toolCalls: [
        {
          id: 't1',
          name: 'evaluate_lead',
          arguments: { score: 4, stage: 'Narnia', summary: 'x' },
        },
      ],
    })
    await analyzeDealFromConversation(baseArgs())

    expect(h.updates[0].stage_id).toBe('stage-a')
    expect(h.updates[0].ai_stage_id).toBeNull()
  })

  it('no-ops when the account has no pipeline', async () => {
    h.pipeline = null
    await analyzeDealFromConversation(baseArgs())
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.updates).toHaveLength(0)
    expect(h.inserts).toHaveLength(0)
  })

  it('skips persistence when the model returns no tool call', async () => {
    h.generateReply.mockResolvedValue({
      text: 'no tool call',
      handoff: false,
      usage: null,
    })
    await analyzeDealFromConversation(baseArgs())
    expect(h.updates).toHaveLength(0)
  })

  it('never throws when generation fails (best-effort)', async () => {
    h.generateReply.mockRejectedValue(new Error('provider down'))
    await expect(analyzeDealFromConversation(baseArgs())).resolves.toBeUndefined()
    expect(h.updates).toHaveLength(0)
  })
})
