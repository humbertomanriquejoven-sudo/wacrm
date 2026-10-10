import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  InvalidRecipientError,
  requireMetaPhoneNumberId,
  resolveMetaPhoneNumberId,
  sendMediaMessage,
  sendTemplateMessage,
  sendTextMessage,
  sendTypingIndicator,
} from '@/lib/whatsapp/meta-api'

/**
 * A real sender `phone_number_id` and a distinct fallback, invented — no
 * production id is referenced.
 */
const CONFIG_ID = '1247536128449000'
const ENV_ID = '9922001122334455'

const ENV_KEYS = ['WHATSAPP_PHONE_NUMBER_ID', 'META_PHONE_NUMBER_ID'] as const

let savedEnv: Record<string, string | undefined>

function okResponse(messageId = 'wamid.OUT_1'): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ messages: [{ id: messageId }] }),
    text: async () => JSON.stringify({ messages: [{ id: messageId }] }),
  } as unknown as Response
}

function sentUrl(fetchMock: ReturnType<typeof vi.fn>): string {
  return String((fetchMock.mock.calls[0] as [string, RequestInit])[0])
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
  return JSON.parse(String(init.body)) as Record<string, unknown>
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  fetchMock = vi.fn().mockResolvedValue(okResponse())
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

describe('resolveMetaPhoneNumberId', () => {
  it('returns the config id when it is usable', () => {
    expect(resolveMetaPhoneNumberId(CONFIG_ID)).toBe(CONFIG_ID)
  })

  it('rejects the "unknown" placeholder and falls back to the env', () => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = ENV_ID
    expect(resolveMetaPhoneNumberId('unknown')).toBe(ENV_ID)
    expect(resolveMetaPhoneNumberId('')).toBe(ENV_ID)
    expect(resolveMetaPhoneNumberId(null)).toBe(ENV_ID)
  })

  it('falls back to META_PHONE_NUMBER_ID after WHATSAPP_PHONE_NUMBER_ID', () => {
    process.env.META_PHONE_NUMBER_ID = ENV_ID
    expect(resolveMetaPhoneNumberId('unknown')).toBe(ENV_ID)
  })

  it('is empty when neither the config nor the env carries a real id', () => {
    expect(resolveMetaPhoneNumberId('unknown')).toBe('')
    expect(resolveMetaPhoneNumberId(undefined)).toBe('')
  })

  it('requireMetaPhoneNumberId throws a typed error instead of resolving', () => {
    expect(() => requireMetaPhoneNumberId('unknown')).toThrow(
      InvalidRecipientError,
    )
  })
})

// PRUEBA C — the endpoint can never be /unknown/messages.
describe('sender endpoint is never /unknown/messages', () => {
  it('refuses a text send whose phone_number_id is "unknown" (no HTTP call)', async () => {
    await expect(
      sendTextMessage({
        phoneNumberId: 'unknown',
        accessToken: 'TOKEN',
        to: '573044556788',
        text: 'hola',
      }),
    ).rejects.toBeInstanceOf(InvalidRecipientError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a media send whose phone_number_id is empty', async () => {
    await expect(
      sendMediaMessage({
        phoneNumberId: '',
        accessToken: 'TOKEN',
        to: '573044556788',
        kind: 'image',
        link: 'https://example.test/image.png',
      }),
    ).rejects.toBeInstanceOf(InvalidRecipientError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a template send whose phone_number_id is "unknown"', async () => {
    await expect(
      sendTemplateMessage({
        phoneNumberId: 'unknown',
        accessToken: 'TOKEN',
        to: '573044556788',
        templateName: 'hello_world',
        language: 'en_US',
        params: [],
      }),
    ).rejects.toBeInstanceOf(InvalidRecipientError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a typing indicator whose phone_number_id is "unknown"', async () => {
    await expect(
      sendTypingIndicator({
        phoneNumberId: 'unknown',
        accessToken: 'TOKEN',
        messageId: 'wamid.INBOUND_1',
      }),
    ).rejects.toBeInstanceOf(InvalidRecipientError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the env fallback when the config id is "unknown"', async () => {
    process.env.META_PHONE_NUMBER_ID = ENV_ID
    await sendTextMessage({
      phoneNumberId: 'unknown',
      accessToken: 'TOKEN',
      to: '573044556788',
      text: 'hola',
    })
    expect(sentUrl(fetchMock)).toBe(
      `https://graph.facebook.com/v26.0/${ENV_ID}/messages`,
    )
    expect(sentUrl(fetchMock)).not.toContain('/unknown/')
  })

  it('logs the REAL endpoint in META_API_REJECTED — never a fabricated /unknown', async () => {
    // The log line that framed a healthy URL as
    // "https://graph.facebook.com/v26.0/unknown/messages": the endpoint string
    // used to be synthesized from an error fallback that held no digits. Now
    // the diagnostic echoes the URL the network layer actually hit
    // (`response.url`), so a rejection like 131009 points at the true path and
    // a real endpoint regression is never masked behind the word "unknown".
    fetchMock.mockResolvedValue({
      ok: false,
      status: 433,
      url: `https://graph.facebook.com/v26.0/${CONFIG_ID}/messages`,
      text: async () =>
        JSON.stringify({
          error: {
            message: 'Recipient phone number not in allowed list',
            code: 131009,
          },
        }),
    } as unknown as Response)

    await expect(
      sendTextMessage({
        phoneNumberId: CONFIG_ID,
        accessToken: 'TOKEN',
        to: '1008477715690681',
        text: 'hola',
        contextMessageId: 'wamid.HBgL_INBOUND',
      }),
    ).rejects.toThrow()

    const rejected = vi.mocked(console.error).mock.calls.find(
      (c) => c[0] === 'META_API_REJECTED:',
    )
    expect(rejected).toBeDefined()
    const parsed = JSON.parse(String(rejected![1])) as {
      endpoint: string
      status: number
    }
    expect(parsed.status).toBe(433)
    expect(parsed.endpoint).toBe(
      `https://graph.facebook.com/v26.0/${CONFIG_ID}/messages`,
    )
    expect(parsed.endpoint).not.toContain('/unknown/')
  })
})

// PRUEBA A — a valid E.164 number is sent directly in `to`.
describe('valid E.164 destination', () => {
  it('addresses the number in `to` on the config endpoint', async () => {
    await sendTextMessage({
      phoneNumberId: CONFIG_ID,
      accessToken: 'TOKEN',
      to: '+57 304 455 6788',
      text: 'hola',
    })
    expect(sentUrl(fetchMock)).toBe(
      `https://graph.facebook.com/v26.0/${CONFIG_ID}/messages`,
    )
    const body = sentBody(fetchMock)
    expect(body.to).toBe('573044556788')
    expect(body.recipient).toBeUndefined()
    expect(body.context).toBeUndefined()
  })
})

// PRUEBA B — an opaque numeric wa_id goes in `to`, anchored to the inbound
// wamid; a namespaced BSUID (CASO C) is routed to Meta's `recipient` field
// with `to` omitted and needs no anchor.
describe('opaque wa_id destination', () => {
  it('addresses a numeric wa_id in `to` and attaches the context', async () => {
    await sendTextMessage({
      phoneNumberId: CONFIG_ID,
      accessToken: 'TOKEN',
      to: '1008477715690681',
      text: 'hola',
      contextMessageId: 'wamid.HBgL_INBOUND',
    })
    const body = sentBody(fetchMock)
    expect(body.to).toBe('1008477715690681')
    expect(body.recipient).toBeUndefined()
    expect(body.context).toEqual({ message_id: 'wamid.HBgL_INBOUND' })
  })

  it('routes a namespaced BSUID to `recipient` even with an anchor (CASO C)', async () => {
    await sendTextMessage({
      phoneNumberId: CONFIG_ID,
      accessToken: 'TOKEN',
      to: 'CO.1008477715690681',
      text: 'hola',
      contextMessageId: 'wamid.HBgL_INBOUND',
    })
    const body = sentBody(fetchMock)
    expect(body.recipient).toBe('CO.1008477715690681')
    expect(body.to).toBeUndefined()
  })
})
