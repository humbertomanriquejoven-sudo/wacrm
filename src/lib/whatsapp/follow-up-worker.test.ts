import { afterEach, describe, expect, it, vi } from 'vitest'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => {
  const state = {
    followUps: [] as Record<string, unknown>[],
    waitTimers: [] as Record<string, unknown>[],
    messages: [] as Record<string, unknown>[],
    aiConfig: { created_by: 'user-owner' } as Record<string, unknown> | null,
    // conversations.follow_up_enabled — null = inherit the account switch.
    conversation: { follow_up_enabled: null } as { follow_up_enabled: boolean | null } | null,
    sendMessageToConversation: vi.fn(),
    loadAiConfig: vi.fn(),
    generateReply: vi.fn(),
    buildConversationContext: vi.fn(),
    cancelled: [] as string[],
    completed: [] as string[],
    noResponse: [] as string[],
    waitCancelled: [] as string[],
    waitCompleted: [] as string[],
    waitNoResponse: [] as string[],
    calls: [] as string[],
    followUpsBroken: false,
    waitTimersBroken: false,
  }
  return { state }
})

vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'follow_ups') {
        if (h.state.followUpsBroken) {
          throw new Error(
            'relation "public.follow_ups" does not exist'
          )
        }
        const filters: Array<{ op: 'eq' | 'in' | 'lte'; key: string; value: unknown }> = []
        const matches = (row: Record<string, unknown>) =>
          filters.every((f) => {
            if (f.op === 'eq') return row[f.key] === f.value
            if (f.op === 'in')
              return (
                Array.isArray(f.value) &&
                (f.value as unknown[]).includes(row[f.key])
              )
            if (f.op === 'lte')
              return (row[f.key] as number) <= (f.value as number)
            return true
          })
        const resolve = () => ({
          data: h.state.followUps.filter(matches),
          error: null,
        })
        const chain = {
          select: () => chain,
          eq: (key: string, value: unknown) => {
            filters.push({ op: 'eq', key, value })
            return chain
          },
          in: (key: string, value: unknown) => {
            filters.push({ op: 'in', key, value })
            return chain
          },
          lte: (key: string, value: unknown) => {
            filters.push({ op: 'lte', key, value })
            return chain
          },
          order: () => chain,
          limit: () => chain,
          maybeSingle: () =>
            Promise.resolve({
              data: h.state.followUps.find(matches) ?? null,
              error: null,
            }),
          insert: (payload: Record<string, unknown>) => {
            const id = `fu-${h.state.followUps.length + 1}`
            h.state.followUps.push({ id, ...payload })
            h.state.calls.push('follow_ups.insert')
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({ data: { id, ...payload }, error: null }),
              }),
            }
          },
          update: (payload: Record<string, unknown>) => {
            const status = payload.status
            if (status === 'cancelled') h.state.cancelled.push(status)
            if (status === 'completed') h.state.completed.push(status)
            if (status === 'no_response') h.state.noResponse.push(status)
            // Real client: `.update().eq().eq()` mutates the matching rows.
            // The runner relies on this to see `completed` before scheduling
            // the next stage, so the mock must apply the payload.
            const upFilters: Array<{ key: string; value: unknown }> = []
            const apply = () => {
              for (const row of h.state.followUps) {
                if (upFilters.every((f) => row[f.key] === f.value)) {
                  Object.assign(row, payload)
                }
              }
            }
            return {
              eq: (key: string, value: unknown) => ({
                eq: (key2: string, value2: unknown) => {
                  upFilters.push({ key, value }, { key: key2, value: value2 })
                  apply()
                  return Promise.resolve({ data: null, error: null })
                },
              }),
            }
          },
          then: (
            onFulfilled?: (value: { data: Record<string, unknown>[]; error: null } | null) => void,
            onRejected?: (reason: unknown) => void,
          ) => Promise.resolve(resolve()).then(onFulfilled as never, onRejected as never),
        }
        return chain
      }
      if (table === 'response_wait_timers') {
        if (h.state.waitTimersBroken) {
          throw new Error('relation "public.response_wait_timers" does not exist')
        }
        const filters: Array<{ op: 'eq' | 'lte'; key: string; value: unknown }> = []
        const matches = (row: Record<string, unknown>) =>
          filters.every((f) => {
            if (f.op === 'eq') return row[f.key] === f.value
            if (f.op === 'lte')
              return (row[f.key] as number) <= (f.value as number)
            return true
          })
        const resolve = () => ({
          data: h.state.waitTimers.filter(matches),
          error: null,
        })
        const chain = {
          select: () => chain,
          eq: (key: string, value: unknown) => {
            filters.push({ op: 'eq', key, value })
            return chain
          },
          in: (key: string, value: unknown) => {
            filters.push({ op: 'eq', key, value })
            return chain
          },
          lte: (key: string, value: unknown) => {
            filters.push({ op: 'lte', key, value })
            return chain
          },
          order: () => chain,
          limit: () => chain,
          maybeSingle: () =>
            Promise.resolve({
              data: h.state.waitTimers.find(matches) ?? null,
              error: null,
            }),
          insert: (payload: Record<string, unknown>) => {
            const id = `wait-${h.state.waitTimers.length + 1}`
            h.state.waitTimers.push({ id, ...payload })
            h.state.calls.push('response_wait_timers.insert')
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({ data: { id, ...payload }, error: null }),
              }),
            }
          },
          update: (payload: Record<string, unknown>) => {
            const status = payload.status
            if (status === 'cancelled') h.state.waitCancelled.push(status)
            if (status === 'completed') h.state.waitCompleted.push(status)
            if (status === 'no_response') h.state.waitNoResponse.push(status)
            const upFilters: Array<{ key: string; value: unknown }> = []
            const apply = () => {
              for (const row of h.state.waitTimers) {
                if (upFilters.every((f) => row[f.key] === f.value)) {
                  Object.assign(row, payload)
                }
              }
            }
            return {
              eq: (key: string, value: unknown) => ({
                eq: (key2: string, value2: unknown) => {
                  upFilters.push({ key, value }, { key: key2, value: value2 })
                  apply()
                  return Promise.resolve({ data: null, error: null })
                },
              }),
            }
          },
          then: (
            onFulfilled?: (value: { data: Record<string, unknown>[]; error: null } | null) => void,
            onRejected?: (reason: unknown) => void,
          ) => Promise.resolve(resolve()).then(onFulfilled as never, onRejected as never),
        }
        return chain
      }
      if (table === 'messages') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: h.state.messages[0] ?? null,
                      error: null,
                    }),
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'ai_configs') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: h.state.aiConfig, error: null }),
            }),
          }),
        }
      }
      if (table === 'conversations') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: h.state.conversation, error: null }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))

vi.mock('@/lib/whatsapp/send-message', () => ({
  sendMessageToConversation: h.state.sendMessageToConversation,
}))

vi.mock('@/lib/ai/config', () => ({
  loadAiConfig: h.state.loadAiConfig,
}))

vi.mock('@/lib/ai/generate', () => ({
  generateReply: h.state.generateReply,
  stripInternalReasoning: (text: string) => text,
}))

vi.mock('@/lib/ai/context', () => ({
  buildConversationContext: h.state.buildConversationContext,
}))

import {
  scheduleFollowUp,
  scheduleManualFollowUp,
  scheduleResponseWaitTimer,
  armResponseWaitIfIdle,
  cancelResponseWaitTimers,
  cancelPendingFollowUps,
  runDueFollowUps,
  runDueResponseWaitTimers,
  runScheduledFollowUps,
  FOLLOW_UP_DELAY_MS,
} from './follow-up-worker'

function resetState() {
  h.state.followUps = []
  h.state.waitTimers = []
  h.state.messages = []
  h.state.aiConfig = { created_by: 'user-owner' }
  h.state.conversation = { follow_up_enabled: null }
  h.state.cancelled = []
  h.state.completed = []
  h.state.noResponse = []
  h.state.waitCancelled = []
  h.state.waitCompleted = []
  h.state.waitNoResponse = []
  h.state.calls = []
  h.state.followUpsBroken = false
  h.state.waitTimersBroken = false
  h.state.sendMessageToConversation.mockReset().mockResolvedValue({
    messageId: 'msg-fu',
    whatsappMessageId: 'wamid-fu',
  })
  h.state.loadAiConfig.mockReset().mockResolvedValue({
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiKey: 'plaintext-key',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
  })
  h.state.generateReply.mockReset().mockResolvedValue({
    text: '¿Quedó todo claro? Avísame si necesitas algo más.',
    handoff: false,
    usage: null,
  })
  h.state.buildConversationContext.mockReset().mockResolvedValue([
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: '¡Hola! ¿En qué te ayudo?' },
  ])
}

afterEach(() => {
  vi.useRealTimers()
  resetState()
})

describe('scheduleFollowUp', () => {
  it('inserts a pending follow-up due exactly 10 minutes out', async () => {
    resetState()
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()
    const now = new Date('2026-10-06T12:00:00.000Z')

    const res = await scheduleFollowUp(db, {
      conversationId: 'conv-1',
      contactId: 'contact-1',
      accountId: 'account-1',
      delayMs: FOLLOW_UP_DELAY_MS,
      now,
    })

    expect(res.scheduled).toBe(true)
    expect(res.reason).toBe('scheduled')
    expect(h.state.followUps[0]).toMatchObject({
      conversation_id: 'conv-1',
      contact_id: 'contact-1',
      account_id: 'account-1',
      type: '10m',
      status: 'pending',
      execute_at: '2026-10-06T12:10:00.000Z',
    })
  })

  it('refuses to schedule when the contact already had its one follow-up of that type', async () => {
    resetState()
    h.state.followUps = [
      {
        id: 'fu-old',
        status: 'completed',
        contact_id: 'contact-1',
        type: '10m',
      },
    ]
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await scheduleFollowUp(db, {
      conversationId: 'conv-1',
      contactId: 'contact-1',
      accountId: 'account-1',
    })

    expect(res).toMatchObject({
      scheduled: false,
      reason: 'already_followed_up',
    })
  })

  it('allows the 24h stage even after the 10m was already delivered (per-type limit)', async () => {
    resetState()
    h.state.followUps = [
      {
        id: 'fu-10m',
        status: 'completed',
        contact_id: 'contact-1',
        type: '10m',
      },
    ]
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await scheduleFollowUp(db, {
      conversationId: 'conv-1',
      contactId: 'contact-1',
      accountId: 'account-1',
      type: '24h',
    })

    expect(res.scheduled).toBe(true)
    expect(res.reason).toBe('scheduled')
    expect(h.state.followUps[1]).toMatchObject({
      type: '24h',
      status: 'pending',
      contact_id: 'contact-1',
    })
  })

  it('refuses to schedule when the account-wide switch is OFF', async () => {
    resetState()
    h.state.aiConfig = { created_by: 'user-owner', follow_up_enabled: false }
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await scheduleFollowUp(db, {
      conversationId: 'conv-1',
      contactId: 'contact-1',
      accountId: 'account-1',
    })

    expect(res.scheduled).toBe(false)
    expect(res.reason).toBe('disabled')
  })

  it('refuses to schedule when the chat override is OFF', async () => {
    resetState()
    h.state.conversation = { follow_up_enabled: false }
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await scheduleFollowUp(db, {
      conversationId: 'conv-1',
      contactId: 'contact-1',
      accountId: 'account-1',
    })

    expect(res.scheduled).toBe(false)
    expect(res.reason).toBe('disabled')
  })

  it('refuses to schedule when the same conversation already has a pending one', async () => {
    resetState()
    h.state.followUps = [
      {
        id: 'fu-pending',
        status: 'pending',
        conversation_id: 'conv-1',
      },
    ]
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await scheduleFollowUp(db, {
      conversationId: 'conv-1',
      contactId: 'contact-1',
      accountId: 'account-1',
    })

    expect(res).toMatchObject({
      scheduled: false,
      reason: 'duplicate_pending',
    })
  })

  it('never throws when the database is unavailable (missing follow_ups table)', async () => {
    resetState()
    h.state.followUpsBroken = true
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await scheduleFollowUp(db, {
      conversationId: 'conv-1',
      contactId: 'contact-1',
      accountId: 'account-1',
    })

    expect(res.scheduled).toBe(false)
    expect(res.reason).toBe('error')
  })
})

describe('scheduleManualFollowUp', () => {
  it('schedules the EXACT typed delay, bypassing the automatic historic budget', async () => {
    resetState()
    // The contact already consumed its one automatic 10m reminder; a manual
    // schedule must still succeed (this is the "Couldn't schedule" bug).
    h.state.followUps = [
      {
        id: 'fu-old',
        status: 'completed',
        contact_id: 'contact-1',
        type: '10m',
      },
    ]
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()
    const now = new Date('2026-10-06T12:00:00.000Z')

    const res = await scheduleManualFollowUp(db, {
      conversationId: 'conv-1',
      contactId: 'contact-1',
      accountId: 'account-1',
      delayMs: 1 * 60 * 1000,
      now,
    })

    expect(res).toMatchObject({ scheduled: true, reason: 'scheduled' })
    const created = h.state.followUps.find((r) => r.status === 'pending')
    expect(created).toMatchObject({
      conversation_id: 'conv-1',
      execute_at: '2026-10-06T12:01:00.000Z',
      status: 'pending',
    })
  })

  it('moves the existing pending row instead of stacking a duplicate', async () => {
    resetState()
    h.state.followUps = [
      {
        id: 'fu-pending',
        status: 'pending',
        conversation_id: 'conv-1',
        contact_id: 'contact-1',
        type: '10m',
        execute_at: '2026-10-06T12:10:00.000Z',
      },
    ]
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await scheduleManualFollowUp(db, {
      conversationId: 'conv-1',
      contactId: 'contact-1',
      accountId: 'account-1',
      delayMs: 1 * 60 * 1000,
      now: new Date('2026-10-06T12:00:00.000Z'),
    })

    expect(res).toMatchObject({ scheduled: true, reason: 'scheduled' })
    expect(h.state.followUps).toHaveLength(1)
    expect(h.state.followUps[0]).toMatchObject({
      execute_at: '2026-10-06T12:01:00.000Z',
      status: 'pending',
    })
  })
})

describe('scheduleResponseWaitTimer', () => {
  it('arms the wait timer for EXACTLY now + N minutes', async () => {
    resetState()
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await scheduleResponseWaitTimer(db, {
      conversationId: 'conv-1',
      contactId: 'contact-1',
      accountId: 'account-1',
      delayMinutes: 5,
      now: new Date('2026-10-06T12:00:00.000Z'),
    })

    expect(res).toMatchObject({ scheduled: true, reason: 'scheduled' })
    expect(res.expires_at).toBe('2026-10-06T12:05:00.000Z')
    expect(h.state.waitTimers).toHaveLength(1)
    expect(h.state.waitTimers[0]).toMatchObject({
      conversation_id: 'conv-1',
      contact_id: 'contact-1',
      account_id: 'account-1',
      status: 'active',
      delay_minutes: 5,
      started_at: '2026-10-06T12:00:00.000Z',
      expires_at: '2026-10-06T12:05:00.000Z',
    })
  })

  it('re-arms the SAME active row (no stacking, no duplicates)', async () => {
    resetState()
    h.state.waitTimers = [
      {
        id: 'wait-1',
        conversation_id: 'conv-1',
        contact_id: 'contact-1',
        status: 'active',
        delay_minutes: 10,
        started_at: '2026-10-06T12:00:00.000Z',
        expires_at: '2026-10-06T12:10:00.000Z',
      },
    ]
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await scheduleResponseWaitTimer(db, {
      conversationId: 'conv-1',
      contactId: 'contact-1',
      accountId: 'account-1',
      delayMinutes: 3,
      now: new Date('2026-10-06T12:02:00.000Z'),
    })

    expect(res).toMatchObject({ scheduled: true })
    expect(h.state.waitTimers).toHaveLength(1)
    expect(h.state.waitTimers[0]).toMatchObject({
      delay_minutes: 3,
      started_at: '2026-10-06T12:02:00.000Z',
      expires_at: '2026-10-06T12:05:00.000Z',
    })
  })

  it('is strictly per-conversation: arming Chat A never touches Chat B', async () => {
    resetState()
    h.state.waitTimers = [
      {
        id: 'wait-b',
        conversation_id: 'conv-b',
        status: 'active',
        delay_minutes: 10,
        started_at: '2026-10-06T12:00:00.000Z',
        expires_at: '2026-10-06T12:10:00.000Z',
      },
    ]
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await scheduleResponseWaitTimer(db, {
      conversationId: 'conv-1',
      contactId: 'contact-1',
      accountId: 'account-1',
      delayMinutes: 1,
      now: new Date('2026-10-06T12:00:00.000Z'),
    })

    expect(res.scheduled).toBe(true)
    expect(h.state.waitTimers).toHaveLength(2)
    // Chat B's row is byte-for-byte untouched.
    expect(h.state.waitTimers[0]).toMatchObject({
      id: 'wait-b',
      conversation_id: 'conv-b',
      expires_at: '2026-10-06T12:10:00.000Z',
    })
    expect(h.state.waitTimers[1]).toMatchObject({ conversation_id: 'conv-1' })
  })
})

describe('cancelResponseWaitTimers', () => {
  it('cancels every ACTIVE wait timer of the conversation', async () => {
    resetState()
    h.state.waitTimers = [
      {
        id: 'wait-1',
        conversation_id: 'conv-1',
        status: 'active',
      },
      {
        id: 'wait-2',
        conversation_id: 'conv-2',
        status: 'active',
      },
    ]
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    await cancelResponseWaitTimers(db, 'conv-1')

    expect(h.state.waitCancelled).toEqual(['cancelled'])
    // Only conv-1's row moved; conv-2 is untouched.
    expect(h.state.waitTimers[0]).toMatchObject({ status: 'cancelled' })
    expect(h.state.waitTimers[1]).toMatchObject({ status: 'active' })
  })

  it('records WHY it was cancelled (default: inbound — the customer replied)', async () => {
    resetState()
    h.state.waitTimers = [
      {
        id: 'wait-1',
        conversation_id: 'conv-1',
        status: 'active',
      },
    ]
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    await cancelResponseWaitTimers(db, 'conv-1')

    expect(h.state.waitTimers[0]).toMatchObject({
      status: 'cancelled',
      cancelled_reason: 'inbound',
    })
  })

  it('embeds the given reason (manual → agent cancellation)', async () => {
    resetState()
    h.state.waitTimers = [
      {
        id: 'wait-1',
        conversation_id: 'conv-1',
        status: 'active',
      },
    ]
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    await cancelResponseWaitTimers(db, 'conv-1', 'manual')

    expect(h.state.waitTimers[0]).toMatchObject({
      status: 'cancelled',
      cancelled_reason: 'manual',
    })
  })
})

describe('armResponseWaitIfIdle — auto-start on send', () => {
  it('continues (never duplicates) when an ACTIVE countdown already exists', async () => {
    resetState()
    h.state.waitTimers = [
      {
        id: 'wait-1',
        conversation_id: 'conv-1',
        contact_id: 'contact-1',
        account_id: 'account-1',
        status: 'active',
        delay_minutes: 5,
        started_at: '2026-10-06T12:00:00.000Z',
        expires_at: '2026-10-06T12:05:00.000Z',
      },
    ]
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await armResponseWaitIfIdle(db, {
      conversationId: 'conv-1',
      contactId: 'contact-1',
      accountId: 'account-1',
      now: new Date('2026-10-06T12:01:00.000Z'),
    })

    expect(res.reason).toBe('already_active')
    // One row only — a second send mid-wait must never stack a twin.
    expect(h.state.waitTimers).toHaveLength(1)
    expect(h.state.waitTimers[0]).toMatchObject({
      status: 'active',
      expires_at: '2026-10-06T12:05:00.000Z',
    })
  })

  it("re-arms with the chat's LAST-USED minutes after the reply cancelled it", async () => {
    resetState()
    h.state.waitTimers = [
      {
        id: 'wait-0',
        conversation_id: 'conv-1',
        contact_id: 'contact-1',
        account_id: 'account-1',
        status: 'cancelled',
        cancelled_reason: 'inbound',
        delay_minutes: 2,
        started_at: '2026-10-06T11:00:00.000Z',
        expires_at: '2026-10-06T11:02:00.000Z',
        updated_at: '2026-10-06T11:02:00.000Z',
      },
    ]
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await armResponseWaitIfIdle(db, {
      conversationId: 'conv-1',
      contactId: 'contact-1',
      accountId: 'account-1',
      now: new Date('2026-10-06T12:00:00.000Z'),
    })

    expect(res.reason).toBe('armed')
    expect(h.state.waitTimers).toHaveLength(2)
    expect(h.state.waitTimers[1]).toMatchObject({
      conversation_id: 'conv-1',
      status: 'active',
      delay_minutes: 2,
      expires_at: '2026-10-06T12:02:00.000Z',
    })
  })

  it('defaults to 10 minutes for a chat that never used Timer 2', async () => {
    resetState()
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await armResponseWaitIfIdle(db, {
      conversationId: 'conv-1',
      contactId: 'contact-1',
      accountId: 'account-1',
      now: new Date('2026-10-06T12:00:00.000Z'),
    })

    expect(res.reason).toBe('armed')
    expect(h.state.waitTimers).toHaveLength(1)
    expect(h.state.waitTimers[0]).toMatchObject({
      status: 'active',
      delay_minutes: 10,
      expires_at: '2026-10-06T12:10:00.000Z',
    })
  })
})

describe('cancelPendingFollowUps', () => {
  it('marks pending follow-ups of the conversation as cancelled', async () => {
    resetState()
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    await cancelPendingFollowUps(db, 'conv-1')

    expect(h.state.cancelled).toEqual(['cancelled'])
  })
})

describe('runDueFollowUps', () => {
  it('sends a generated reminder and marks the follow-up completed', async () => {
    resetState()
    h.state.followUps = [
      {
        id: 'fu-1',
        conversation_id: 'conv-1',
        contact_id: 'contact-1',
        account_id: 'account-1',
        type: '10m',
        status: 'pending',
        execute_at: '2026-10-06T12:09:00.000Z',
      },
    ]
    h.state.messages = [
      { sender_type: 'bot', content_text: '¡Hola! ¿En qué te ayudo?' },
    ]
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await runDueFollowUps(db, new Date('2026-10-06T12:10:00.000Z'))

    expect(res).toMatchObject({ scanned: 1, sent: 1 })
    expect(h.state.sendMessageToConversation).toHaveBeenCalledTimes(1)
    expect(h.state.sendMessageToConversation).toHaveBeenCalledWith(
      expect.anything(),
      'account-1',
      expect.objectContaining({
        conversationId: 'conv-1',
        messageType: 'text',
        senderType: 'bot',
        aiGenerated: true,
        contentText: '¿Quedó todo claro? Avísame si necesitas algo más.',
      }),
    )
    expect(h.state.completed).toEqual(['completed'])
  })

  it('cancels instead of sending when the customer replied AFTER it was scheduled', async () => {
    resetState()
    h.state.followUps = [
      {
        id: 'fu-1',
        conversation_id: 'conv-1',
        contact_id: 'contact-1',
        account_id: 'account-1',
        type: '10m',
        status: 'pending',
        created_at: '2026-10-06T12:00:00.000Z',
        execute_at: '2026-10-06T12:09:00.000Z',
      },
    ]
    // The customer DID reply within the window — and wrote after the
    // reminder was queued, so it is obsolete.
    h.state.messages = [
      {
        sender_type: 'customer',
        content_text: 'gracias',
        created_at: '2026-10-06T12:05:00.000Z',
      },
    ]
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await runDueFollowUps(db, new Date('2026-10-06T12:10:00.000Z'))

    expect(res).toMatchObject({ scanned: 1, cancelled: 1, sent: 0 })
    expect(h.state.sendMessageToConversation).not.toHaveBeenCalled()
    expect(h.state.cancelled).toEqual(['cancelled'])
  })

  it('sends a MANUAL timer even when the customer message is the last one (reply predates scheduling)', async () => {
    resetState()
    h.state.followUps = [
      {
        id: 'fu-1',
        conversation_id: 'conv-1',
        contact_id: 'contact-1',
        account_id: 'account-1',
        type: '10m',
        status: 'pending',
        // Agent scheduled the chase at 12:00, while the customer's last
        // message (11:50) was still unanswered.
        created_at: '2026-10-06T12:00:00.000Z',
        execute_at: '2026-10-06T12:05:00.000Z',
      },
    ]
    h.state.messages = [
      {
        sender_type: 'customer',
        content_text: 'info por favor',
        created_at: '2026-10-06T11:50:00.000Z',
      },
    ]
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await runDueFollowUps(db, new Date('2026-10-06T12:05:01.000Z'))

    expect(res).toMatchObject({ scanned: 1, cancelled: 0, sent: 1 })
    expect(h.state.sendMessageToConversation).toHaveBeenCalledTimes(1)
    expect(h.state.cancelled).toEqual([])
    expect(h.state.completed).toEqual(['completed'])
  })

  it('fires a manually scheduled 1-minute timer exactly once at T+1min', async () => {
    resetState()
    h.state.messages = [{ sender_type: 'bot', content_text: 'hi' }]
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()
    const now = new Date('2026-10-06T12:00:00.000Z')

    const sched = await scheduleManualFollowUp(db, {
      conversationId: 'conv-1',
      contactId: 'contact-1',
      accountId: 'account-1',
      delayMs: 60 * 1000,
      now,
    })
    expect(sched.scheduled).toBe(true)

    // Not due yet at T+30s.
    const early = await runDueFollowUps(db, new Date('2026-10-06T12:00:30.000Z'))
    expect(early.sent).toBe(0)

    // Due exactly at T+1min: one send, and only one.
    const due = await runDueFollowUps(db, new Date('2026-10-06T12:01:00.000Z'))
    expect(due).toMatchObject({ scanned: 1, sent: 1 })

    const again = await runDueFollowUps(db, new Date('2026-10-06T12:02:00.000Z'))
    expect(again.sent).toBe(0)
    expect(h.state.sendMessageToConversation).toHaveBeenCalledTimes(1)
  })

  it('cancels instead of sending when the per-chat switch is OFF', async () => {
    resetState()
    h.state.conversation = { follow_up_enabled: false }
    h.state.followUps = [
      {
        id: 'fu-1',
        conversation_id: 'conv-1',
        contact_id: 'contact-1',
        account_id: 'account-1',
        type: '10m',
        status: 'pending',
        execute_at: '2026-10-06T12:09:00.000Z',
      },
    ]
    h.state.messages = [{ sender_type: 'bot', content_text: 'hi' }]
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await runDueFollowUps(db, new Date('2026-10-06T12:10:00.000Z'))

    expect(res).toMatchObject({ scanned: 1, sent: 0, cancelled: 1 })
    expect(h.state.sendMessageToConversation).not.toHaveBeenCalled()
    expect(h.state.cancelled).toEqual(['cancelled'])
  })

  it('falls back to a generic reminder when no AI config exists', async () => {
    resetState()
    h.state.loadAiConfig.mockResolvedValue(null)
    h.state.followUps = [
      {
        id: 'fu-1',
        conversation_id: 'conv-1',
        contact_id: 'contact-1',
        account_id: 'account-1',
        type: '10m',
        status: 'pending',
        execute_at: '2026-10-06T12:09:00.000Z',
      },
    ]
    h.state.messages = [{ sender_type: 'bot', content_text: 'hi' }]
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await runDueFollowUps(db, new Date('2026-10-06T12:10:00.000Z'))

    expect(res.sent).toBe(1)
    expect(h.state.sendMessageToConversation).toHaveBeenCalledWith(
      expect.anything(),
      'account-1',
      expect.objectContaining({ contentText: expect.any(String) }),
    )
    expect(h.state.generateReply).not.toHaveBeenCalled()
    expect(h.state.completed).toEqual(['completed'])
  })

  it('marks no_response when the send to WhatsApp fails', async () => {
    resetState()
    h.state.sendMessageToConversation.mockRejectedValue(new Error('Meta 131030'))
    h.state.followUps = [
      {
        id: 'fu-1',
        conversation_id: 'conv-1',
        contact_id: 'contact-1',
        account_id: 'account-1',
        type: '10m',
        status: 'pending',
        execute_at: '2026-10-06T12:09:00.000Z',
      },
    ]
    h.state.messages = [{ sender_type: 'bot', content_text: 'hi' }]
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await runDueFollowUps(db, new Date('2026-10-06T12:10:00.000Z'))

    expect(res).toMatchObject({ scanned: 1, noResponse: 1, sent: 0 })
    expect(h.state.sendMessageToConversation).toHaveBeenCalledTimes(1)
    expect(h.state.noResponse).toEqual(['no_response'])
  })

  it('handles an empty queue without failing', async () => {
    resetState()
    h.state.followUps = []
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await runDueFollowUps(db, new Date())

    expect(res).toMatchObject({ scanned: 0, sent: 0, cancelled: 0 })
    expect(h.state.sendMessageToConversation).not.toHaveBeenCalled()
  })

  it('never throws when the database is unavailable (missing follow_ups table)', async () => {
    resetState()
    h.state.followUpsBroken = true

    const res = await runDueFollowUps(null, new Date())

    expect(res).toMatchObject({ scanned: 0, sent: 0, cancelled: 0, noResponse: 0 })
    expect(h.state.sendMessageToConversation).not.toHaveBeenCalled()
  })

  it('queues the 24h stage after the 10m reminder is delivered', async () => {
    resetState()
    h.state.followUps = [
      {
        id: 'fu-1',
        conversation_id: 'conv-1',
        contact_id: 'contact-1',
        account_id: 'account-1',
        type: '10m',
        status: 'pending',
        execute_at: '2026-10-06T12:09:00.000Z',
      },
    ]
    h.state.messages = [{ sender_type: 'bot', content_text: 'hi' }]
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await runDueFollowUps(db, new Date('2026-10-06T12:10:00.000Z'))

    expect(res).toMatchObject({ scanned: 1, sent: 1, scheduled: 1 })
    expect(h.state.followUps).toHaveLength(2)
    expect(h.state.followUps[1]).toMatchObject({
      type: '24h',
      status: 'pending',
      conversation_id: 'conv-1',
      contact_id: 'contact-1',
    })
  })

  it('does not schedule anything after the 24h stage fires', async () => {
    resetState()
    h.state.followUps = [
      {
        id: 'fu-24',
        conversation_id: 'conv-1',
        contact_id: 'contact-1',
        account_id: 'account-1',
        type: '24h',
        status: 'pending',
        execute_at: '2026-10-07T12:00:00.000Z',
      },
    ]
    h.state.messages = [{ sender_type: 'bot', content_text: 'hi' }]
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await runDueFollowUps(db, new Date('2026-10-07T12:00:01.000Z'))

    expect(res).toMatchObject({ scanned: 1, sent: 1, scheduled: 0 })
    expect(h.state.followUps).toHaveLength(1)
    expect(h.state.followUps[0]).toMatchObject({ status: 'completed', type: '24h' })
  })
})

describe('runDueResponseWaitTimers', () => {
  it('sends ONE generated nudge at expiry, then closes the timer as completed (single execution)', async () => {
    resetState()
    h.state.waitTimers = [
      {
        id: 'wait-1',
        conversation_id: 'conv-1',
        contact_id: 'contact-1',
        account_id: 'account-1',
        status: 'active',
        delay_minutes: 5,
        started_at: '2026-10-06T12:00:00.000Z',
        expires_at: '2026-10-06T12:05:00.000Z',
      },
    ]
    // The agent's message is the last one; the customer never replied.
    h.state.messages = [{ sender_type: 'bot', content_text: '¡Hola! ¿En qué te ayudo?' }]
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await runDueResponseWaitTimers(db, new Date('2026-10-06T12:05:01.000Z'))

    expect(res).toMatchObject({ scanned: 1, sent: 1 })
    expect(h.state.sendMessageToConversation).toHaveBeenCalledTimes(1)
    expect(h.state.sendMessageToConversation).toHaveBeenCalledWith(
      expect.anything(),
      'account-1',
      expect.objectContaining({
        conversationId: 'conv-1',
        messageType: 'text',
        senderType: 'bot',
        aiGenerated: true,
        autoArm: false,
        contentText: '¿Quedó todo claro? Avísame si necesitas algo más.',
      }),
    )
    // ONE-SHOT: the nudge went out exactly once; the timer closes as
    // `completed` and NEVER re-arms by itself. The agent must press
    // ↻ Reiniciar (or the next outbound) to watch again.
    expect(h.state.waitCompleted).toEqual(['completed'])
    expect(h.state.waitTimers).toHaveLength(1)
    expect(h.state.waitTimers[0]).toMatchObject({
      id: 'wait-1',
      status: 'completed',
      delay_minutes: 5,
      started_at: '2026-10-06T12:00:00.000Z',
      expires_at: '2026-10-06T12:05:00.000Z',
    })
  })

  it('cancels without sending when the customer replied AT/AFTER started_at', async () => {
    resetState()
    h.state.waitTimers = [
      {
        id: 'wait-1',
        conversation_id: 'conv-1',
        contact_id: 'contact-1',
        account_id: 'account-1',
        status: 'active',
        delay_minutes: 5,
        started_at: '2026-10-06T12:00:00.000Z',
        expires_at: '2026-10-06T12:05:00.000Z',
      },
    ]
    h.state.messages = [
      { sender_type: 'customer', content_text: 'gracias', created_at: '2026-10-06T12:02:00.000Z' },
    ]
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await runDueResponseWaitTimers(db, new Date('2026-10-06T12:05:01.000Z'))

    expect(res).toMatchObject({ scanned: 1, sent: 0, cancelled: 1 })
    expect(h.state.sendMessageToConversation).not.toHaveBeenCalled()
    expect(h.state.waitCancelled).toEqual(['cancelled'])
    // Race safety-net cancel is labelled `anti_race` (one-shot bookkeeping).
    expect(h.state.waitTimers[0]).toMatchObject({
      status: 'cancelled',
      cancelled_reason: 'anti_race',
    })
  })

  it('does nothing before expiry', async () => {
    resetState()
    h.state.waitTimers = [
      {
        id: 'wait-1',
        conversation_id: 'conv-1',
        contact_id: 'contact-1',
        account_id: 'account-1',
        status: 'active',
        delay_minutes: 5,
        started_at: '2026-10-06T12:00:00.000Z',
        expires_at: '2026-10-06T12:05:00.000Z',
      },
    ]
    h.state.messages = [{ sender_type: 'bot', content_text: 'hi' }]
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await runDueResponseWaitTimers(db, new Date('2026-10-06T12:04:00.000Z'))

    expect(res).toMatchObject({ scanned: 0, sent: 0 })
  })

  it('never throws when the response_wait_timers table is missing', async () => {
    resetState()
    h.state.waitTimersBroken = true

    const res = await runDueResponseWaitTimers(null, new Date())

    expect(res).toMatchObject({ scanned: 0, sent: 0, cancelled: 0, noResponse: 0 })
    expect(h.state.sendMessageToConversation).not.toHaveBeenCalled()
  })
})

describe('runScheduledFollowUps — both timers run independently', () => {
  it('fires Timer 1 and Timer 2 for the SAME conversation without interference', async () => {
    resetState()
    h.state.followUps = [
      {
        id: 'fu-1',
        conversation_id: 'conv-1',
        contact_id: 'contact-1',
        account_id: 'account-1',
        type: '10m',
        status: 'pending',
        execute_at: '2026-10-06T12:09:00.000Z',
      },
    ]
    h.state.waitTimers = [
      {
        id: 'wait-1',
        conversation_id: 'conv-1',
        contact_id: 'contact-1',
        account_id: 'account-1',
        status: 'active',
        delay_minutes: 5,
        started_at: '2026-10-06T12:00:00.000Z',
        expires_at: '2026-10-06T12:05:00.000Z',
      },
    ]
    h.state.messages = [{ sender_type: 'bot', content_text: 'hi' }]
    const db = (await import('@/lib/ai/admin-client')).supabaseAdmin()

    const res = await runScheduledFollowUps(db, new Date('2026-10-06T12:10:00.000Z'))

    expect(res.followUps).toMatchObject({ scanned: 1, sent: 1 })
    expect(res.responseWait).toMatchObject({ scanned: 1, sent: 1 })
    expect(h.state.sendMessageToConversation).toHaveBeenCalledTimes(2)
    // BOTH timers are one-shot: Timer 1 and Timer 2 each delivered their
    // single action and closed their rows as `completed`.
    expect(h.state.completed).toEqual(['completed'])
    expect(h.state.waitCompleted).toEqual(['completed'])
    expect(h.state.waitTimers[0]).toMatchObject({
      id: 'wait-1',
      status: 'completed',
      started_at: '2026-10-06T12:00:00.000Z',
      expires_at: '2026-10-06T12:05:00.000Z',
    })
  })
})