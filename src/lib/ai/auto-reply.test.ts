import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  engineSendAiReply: vi.fn(),
  executeToolCall: vi.fn(),
  loadContactContext: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    citas: [] as { id: string; fecha_inicio: string; estado: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('./tools', () => ({
  AI_TOOLS: [{ name: 'agendar_cita', description: '', parameters: { type: 'object', properties: {} } }],
  executeToolCall: h.executeToolCall,
  loadContactContext: h.loadContactContext,
  extractBookingResult: (output: string) => {
    const marker = output.lastIndexOf('JSON_RESULT')
    if (marker === -1) return null
    const start = output.indexOf('{', marker)
    if (start === -1) return null
    try {
      const parsed = JSON.parse(output.slice(start)) as Record<string, unknown>
      return {
        confirmado: parsed.confirmado === true,
        link: typeof parsed.link === 'string' ? parsed.link : null,
        inicio: typeof parsed.inicio === 'string' ? parsed.inicio : null,
        idCita: typeof parsed.idCita === 'string' ? parsed.idCita : null,
      }
    } catch {
      return null
    }
  },
}))
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: h.engineSendText,
  engineSendAiReply: h.engineSendAiReply,
}))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      if (table === 'citas') {
        // loadContactContext: .select().eq('contact_id').eq('estado')
        return {
          select: () => ({
            eq: () => ({
              eq: () =>
                Promise.resolve({ data: h.state.citas, error: null }),
            }),
          }),
        }
      }
      // contacts (reads) + conversations (reads + writes)
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import {
  dispatchInboundToAiReply,
  AGENDAR_FALLBACK_MESSAGE,
  guardBookingReply,
} from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
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
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.citas = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.executeToolCall.mockResolvedValue(
    'Cita agendada: 2026-09-18T14:00:00-05:00 (45 minutos) para Carlos. Reunión Meet: https://meet.google.com/abc.\n\n' +
      'JSON_RESULT (no lo repitas en el mensaje al cliente, usa su contenido): ' +
      '{"confirmado":true,"exito":true,"inicio":"2026-09-18T14:00:00-05:00","duracionMin":45,"idCita":"cita-1","link":"https://meet.google.com/abc","estado":"confirmada"}',
  )
  h.loadContactContext.mockImplementation(async () => ({
    name: null,
    email: null,
    location: null,
    citas: h.state.citas,
  }))
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.engineSendAiReply.mockResolvedValue({ whatsapp_message_id: 'm1' })
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('forwards the inbound composeMessageId to the fragment sender', async () => {
    await dispatchInboundToAiReply({ ...ARGS, composeMessageId: 'wamid.IN_1' })

    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ composeMessageId: 'wamid.IN_1' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('injects the contact\'s active citas ids into the system prompt', async () => {
    h.state.citas = [
      { id: 'cita-9', fecha_inicio: '2026-09-10T10:00:00-05:00', estado: 'confirmada' },
    ]
    await dispatchInboundToAiReply(ARGS)
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('idCita="cita-9"')
    expect(systemPrompt).toContain('2026-09-10T10:00:00-05:00')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached (max > 0)', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('replies unlimited when autoReplyMaxPerConversation is 0', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyMaxPerConversation: 0 }))
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 50,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello!' }),
    )
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply, writes a summary, and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })
})

describe('dispatchInboundToAiReply — tool-call lifecycle', () => {
  const toolCall = {
    id: 'call-1',
    name: 'agendar_cita',
    arguments: { inicio: '2026-09-18T14:00:00-05:00', nombre: 'Carlos' },
  }

  it('executes the tool, then makes a second LLM pass to confirm with the Meet link', async () => {
    h.generateReply
      .mockResolvedValueOnce({ text: '', handoff: false, toolCalls: [toolCall] })
      .mockResolvedValueOnce({
        text: '¡Listo! Tu cita quedó para mañana a las 2:00 PM. Meet: https://meet.google.com/abc',
        handoff: false,
      })

    await dispatchInboundToAiReply(ARGS)

    expect(h.executeToolCall).toHaveBeenCalledTimes(1)
    expect(h.generateReply).toHaveBeenCalledTimes(2)
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('https://meet.google.com/abc'),
      }),
    )
    // The tool result was fed back to the model on the confirmation pass.
    const secondMessages = h.generateReply.mock.calls[1][0].messages as {
      role: string
      content: string
    }[]
    expect(secondMessages.some((m) => m.role === 'tool')).toBe(true)
  })

  it('forces a tool-free final pass when repeated tool calls exhaust the round budget', async () => {
    h.generateReply
      .mockResolvedValueOnce({ text: '', handoff: false, toolCalls: [toolCall] })
      .mockResolvedValueOnce({ text: '', handoff: false, toolCalls: [toolCall] })
      .mockResolvedValueOnce({ text: '', handoff: false, toolCalls: [toolCall] })
      .mockResolvedValueOnce({ text: '', handoff: false, toolCalls: [toolCall] })
      .mockResolvedValueOnce({ text: 'Confirmado para mañana a las 2:00 PM.', handoff: false })

    await dispatchInboundToAiReply(ARGS)

    // 4 loop rounds + 1 forced, tool-free pass.
    expect(h.generateReply).toHaveBeenCalledTimes(5)
    const forcedArgs = h.generateReply.mock.calls[4][0] as { tools?: unknown }
    expect(forcedArgs.tools).toBeUndefined()
    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Confirmado para mañana a las 2:00 PM.'),
      }),
    )
  })

  it('never goes silent when the scheduling tool throws — sends the fallback', async () => {
    h.executeToolCall.mockRejectedValue(new Error('network timeout'))
    h.generateReply
      .mockResolvedValueOnce({ text: '', handoff: false, toolCalls: [toolCall] })
      .mockResolvedValueOnce({ text: '', handoff: false, toolCalls: [toolCall] })
      .mockResolvedValueOnce({ text: '', handoff: false, toolCalls: [toolCall] })
      .mockResolvedValueOnce({ text: '', handoff: false, toolCalls: [toolCall] })
      .mockResolvedValueOnce({ text: '', handoff: false })

    await dispatchInboundToAiReply(ARGS)

    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: AGENDAR_FALLBACK_MESSAGE }),
    )
    expect(h.state.updatePayload).toBeNull()
  })

  it('relays the tool fallback message through the model on the next pass', async () => {
    h.executeToolCall.mockRejectedValue(new Error('boom'))
    h.generateReply
      .mockResolvedValueOnce({ text: '', handoff: false, toolCalls: [toolCall] })
      .mockResolvedValueOnce({ text: AGENDAR_FALLBACK_MESSAGE, handoff: false })

    await dispatchInboundToAiReply(ARGS)

    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: AGENDAR_FALLBACK_MESSAGE }),
    )
  })
})

describe('dispatchInboundToAiReply — anti-hallucination guard', () => {
  it('replaces a fake Meet URL invented by the model with the REAL link from the tool', async () => {
    h.executeToolCall.mockResolvedValue(
      'Cita agendada: 2026-09-18T14:00:00-05:00 (45 minutos) para Carlos. Reunión Meet: https://meet.google.com/real-link.\n\n' +
        'JSON_RESULT (no lo repitas en el mensaje al cliente, usa su contenido): ' +
        '{"confirmado":true,"exito":true,"inicio":"2026-09-18T14:00:00-05:00","duracionMin":45,"idCita":"cita-1","link":"https://meet.google.com/real-link","estado":"confirmada"}',
    )
    h.generateReply
      .mockResolvedValueOnce({
        text: '',
        handoff: false,
        toolCalls: [
          {
            id: 'call-1',
            name: 'agendar_cita',
            arguments: { inicio: '2026-09-18T14:00:00-05:00', nombre: 'Carlos' },
          },
        ],
      })
      .mockResolvedValueOnce({
        text: '¡Listo! Agendada tu cita para el jueves a las 2:00 PM. Meet: https://meet.google.com/xxx-yyyy-zzz',
        handoff: false,
      })

    await dispatchInboundToAiReply(ARGS)

    const sent = h.engineSendAiReply.mock.calls[0][0].text as string
    expect(sent).toContain('https://meet.google.com/real-link')
    expect(sent).not.toContain('xxx-yyyy-zzz')
  })

  it('never sends a booking confirmation that has no real tool success — silent handoff', async () => {
    h.buildConversationContext.mockResolvedValue([
      { role: 'user', content: 'Hola, quiero agendar una cita para mañana a las 10 am' },
    ])
    h.generateReply.mockResolvedValue({
      text: '¡Listo! Agendada tu cita para mañana a las 10:00 AM. Meet: https://meet.google.com/xxx-yyyy-zzz',
      handoff: false,
    })

    await dispatchInboundToAiReply(ARGS)

    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.executeToolCall).not.toHaveBeenCalled()
    expect(h.engineSendAiReply).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
  })

  it('never sends an intermediate "un momento…" wait message — silent handoff', async () => {
    h.buildConversationContext.mockResolvedValue([
      { role: 'user', content: 'Quiero agendar una cita, Humberto, por favor' },
    ])
    h.generateReply.mockResolvedValue({
      text: 'Un momento, por favor: estoy registrando tu cita.',
      handoff: false,
    })

    await dispatchInboundToAiReply(ARGS)

    expect(h.engineSendAiReply).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
  })

  it('appends the real link when the model confirms the booking but omits the URL', async () => {
    h.generateReply
      .mockResolvedValueOnce({
        text: '',
        handoff: false,
        toolCalls: [
          {
            id: 'call-1',
            name: 'agendar_cita',
            arguments: { inicio: '2026-09-18T14:00:00-05:00', nombre: 'Carlos' },
          },
        ],
      })
      .mockResolvedValueOnce({
        text: 'Quedó agendada tu cita para el jueves a las 2:00 PM.',
        handoff: false,
      })

    await dispatchInboundToAiReply(ARGS)

    const sent = h.engineSendAiReply.mock.calls[0][0].text as string
    expect(sent).toContain('Quedó agendada tu cita')
    expect(sent).toContain('https://meet.google.com/abc')
  })

  it('strips a stray fake URL from an ordinary (non-booking) reply', async () => {
    h.generateReply.mockResolvedValue({
      text: 'Te comparto el enlace que pidió Juan: https://calendar.google.com/event?eid=abc',
      handoff: false,
    })

    await dispatchInboundToAiReply(ARGS)

    expect(h.engineSendAiReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Te comparto el enlace que pidió Juan: ',
      }),
    )
  })
})

describe('guardBookingReply — pure function', () => {
  const confirmedLink: Parameters<typeof guardBookingReply>[1] = {
    confirmado: true,
    link: 'https://meet.google.com/real-link',
    inicio: '2026-09-18T14:00:00-05:00',
    idCita: 'cita-1',
  }

  it('keeps text untouched when it already quotes the real link', () => {
    const text = 'Cita para jueves 14:00. Meet: https://meet.google.com/real-link'
    expect(guardBookingReply(text, confirmedLink)).toBe(text)
  })

  it('replaces every fake link with the real one', () => {
    const out = guardBookingReply(
      'Meet: https://meet.google.com/fake-aaa y evento https://calendar.google.com/event?eid=zzz',
      confirmedLink,
    )
    expect(out).toBe(
      'Meet: https://meet.google.com/real-link y evento https://meet.google.com/real-link',
    )
  })

  it('replaces a booking claim without real success with null (handoff) under booking context', () => {
    const out = guardBookingReply(
      '¡Listo! Agendada tu cita. Meet: https://meet.google.com/xxx-yyyy-zzz',
      null,
      { bookingContext: true },
    )
    expect(out).toBeNull()
  })

  it('returns null for an intermediate wait message under booking context', () => {
    const out = guardBookingReply(
      'Un momento, por favor: estoy registrando tu cita.',
      null,
      { bookingContext: true },
    )
    expect(out).toBeNull()
  })

  it('keeps a non-booking-context claim but still strips its fake URL', () => {
    const out = guardBookingReply(
      '¡Listo! Agendada tu cita. Meet: https://meet.google.com/xxx-yyyy-zzz',
      null,
    )
    expect(out).toBe('¡Listo! Agendada tu cita. Meet: ')
  })

  it('strips fake URLs but keeps the text when there is no booking claim', () => {
    const out = guardBookingReply(
      'Aquí tienes el enlace: https://meet.google.com/xxx',
      null,
    )
    expect(out).toBe('Aquí tienes el enlace: ')
  })
})
