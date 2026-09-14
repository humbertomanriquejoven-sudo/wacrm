import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const state = {
    contact: { id: 'contact-1', phone: '15551230000' },
    config: {
      phone_number_id: 'pn-1',
      access_token: 'enc',
    },
    messageInserts: [] as Record<string, unknown>[],
    conversationUpdates: [] as Record<string, unknown>[],
    contactUpdates: [] as Record<string, unknown>[],
  }
  return {
    state,
    callMode: { mode: 'single' as 'single' | 'conversation' | 'reject' },
  }
})

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'contacts') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: h.state.contact,
                    error: null,
                  }),
              }),
            }),
          }),
          update: (payload: Record<string, unknown>) => {
            h.state.contactUpdates.push(payload)
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
      }
      if (table === 'whatsapp_config') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: h.state.config, error: null }),
            }),
          }),
        }
      }
      if (table === 'messages') {
        return {
          insert: (payload: Record<string, unknown>) => {
            h.state.messageInserts.push(payload)
            return Promise.resolve({ error: null })
          },
        }
      }
      if (table === 'conversations') {
        return {
          update: (payload: Record<string, unknown>) => {
            h.state.conversationUpdates.push(payload)
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage: vi.fn(),
  sendTypingIndicator: vi.fn(),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'tok'),
}))

import { sendTextMessage, sendTypingIndicator } from '@/lib/whatsapp/meta-api'
import { engineSendAiReply } from './meta-send'

const mockSendTextMessage = vi.mocked(sendTextMessage)
const mockSendTypingIndicator = vi.mocked(sendTypingIndicator)

const ARGS = {
  accountId: 'acct-1',
  userId: 'user-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  text: 'Primero\n\nSegundo\n\nTercero',
  aiGenerated: true,
  composeMessageId: 'wamid.IN_1',
}

beforeEach(() => {
  h.state.messageInserts = []
  h.state.conversationUpdates = []
  h.state.contactUpdates = []
  h.callMode.mode = 'single'
  mockSendTextMessage.mockReset()
  mockSendTypingIndicator.mockReset()
  mockSendTextMessage.mockResolvedValue({ messageId: 'wamid.frag' })
  mockSendTypingIndicator.mockResolvedValue(undefined)
})
afterEach(() => {
  vi.clearAllMocks()
})

describe('engineSendAiReply', () => {
  it('sends each paragraph as its own bubble and persists one row per fragment', async () => {
    const result = await engineSendAiReply(ARGS)

    expect(result).toEqual({ whatsapp_message_id: 'wamid.frag' })
    expect(mockSendTextMessage).toHaveBeenCalledTimes(3)
    expect(mockSendTextMessage.mock.calls.map((c) => c[0].text)).toEqual([
      'Primero',
      'Segundo',
      'Tercero',
    ])
    expect(h.state.messageInserts).toHaveLength(3)
    expect(h.state.messageInserts.map((m) => m.content_text)).toEqual([
      'Primero',
      'Segundo',
      'Tercero',
    ])
    expect(h.state.messageInserts.every((m) => m.ai_generated === true)).toBe(true)
    // One conversation update with the full reply text as preview.
    expect(h.state.conversationUpdates).toHaveLength(1)
    expect(h.state.conversationUpdates[0].last_message_text).toBe(
      'Primero\n\nSegundo\n\nTercero',
    )
  })

  it('refreshes the typing indicator before each fragment after the first', async () => {
    await engineSendAiReply(ARGS)

    expect(mockSendTypingIndicator).toHaveBeenCalledTimes(2)
    expect(mockSendTypingIndicator).toHaveBeenNthCalledWith(1, {
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
      messageId: 'wamid.IN_1',
    })
    expect(mockSendTypingIndicator).toHaveBeenNthCalledWith(2, {
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
      messageId: 'wamid.IN_1',
    })
  })

  it('skips the composing refresh when no composeMessageId is provided', async () => {
    await engineSendAiReply({ ...ARGS, composeMessageId: undefined })

    expect(mockSendTypingIndicator).not.toHaveBeenCalled()
    expect(mockSendTextMessage).toHaveBeenCalledTimes(3)
  })

  it('never lets a failed typing indicator block the reply', async () => {
    mockSendTypingIndicator.mockRejectedValueOnce(new Error('Meta API error: 400'))

    await expect(engineSendAiReply(ARGS)).resolves.toEqual({
      whatsapp_message_id: 'wamid.frag',
    })
    expect(mockSendTextMessage).toHaveBeenCalledTimes(3)
  })

  it('merges overflow paragraphs into the final message (3-bubble cap)', async () => {
    await engineSendAiReply({
      ...ARGS,
      text: 'A\n\nB\n\nC\n\nD\n\nE',
      composeMessageId: undefined,
    })

    expect(mockSendTextMessage).toHaveBeenCalledTimes(3)
    expect(mockSendTextMessage.mock.calls.map((c) => c[0].text)).toEqual([
      'A',
      'B',
      'C\n\nD\n\nE',
    ])
  })

  it('sends a single paragraph as one message with no composing refresh', async () => {
    await engineSendAiReply({ ...ARGS, text: 'Hola' })

    expect(mockSendTextMessage).toHaveBeenCalledTimes(1)
    expect(mockSendTextMessage.mock.calls[0][0].text).toBe('Hola')
    expect(mockSendTypingIndicator).not.toHaveBeenCalled()
    expect(h.state.messageInserts).toHaveLength(1)
  })
})