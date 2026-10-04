import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  cleanRecipientAddress,
  isOpaqueMetaId,
  InvalidRecipientError,
  MetaApiError,
  sendTextMessage,
  toMetaTargetId,
} from '@/lib/whatsapp/meta-api'

/** Capture the JSON body of the single fetch call a send made. */
function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
  return JSON.parse(String(init.body)) as Record<string, unknown>
}

function okResponse(messageId = 'wamid.OUT_1'): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ messages: [{ id: messageId }] }),
    text: async () => JSON.stringify({ messages: [{ id: messageId }] }),
  } as unknown as Response
}

describe('cleanRecipientAddress', () => {
  it('drops an @lid routing suffix', () => {
    expect(cleanRecipientAddress('123456789@lid')).toBe('123456789')
  })

  it('drops an @user routing suffix', () => {
    expect(cleanRecipientAddress('987654321@user')).toBe('987654321')
  })

  it('strips a leading @ when there is no suffix', () => {
    expect(cleanRecipientAddress('@573167071066')).toBe('573167071066')
  })

  it('leaves a namespaced BSUID prefix intact rather than fabricating a number', () => {
    expect(cleanRecipientAddress('CO.1008477715690681')).toBe('CO.1008477715690681')
  })

  it('is empty for an empty address', () => {
    expect(cleanRecipientAddress('')).toBe('')
  })
})

describe('toMetaTargetId', () => {
  it('leaves a plain phone number untouched', () => {
    expect(toMetaTargetId('573167071066')).toBe('573167071066')
  })

  it('strips a CO. namespace down to the numeric id', () => {
    expect(toMetaTargetId('CO.1008477715690681')).toBe('1008477715690681')
  })

  it('strips a WAID. namespace', () => {
    expect(toMetaTargetId('WAID.987654321')).toBe('987654321')
  })

  it('strips an @lid routing suffix', () => {
    expect(toMetaTargetId('123456@lid')).toBe('123456')
  })

  it('strips an @user routing suffix', () => {
    expect(toMetaTargetId('987654321@user')).toBe('987654321')
  })

  it('returns the bare handle when there are no digits at all', () => {
    expect(toMetaTargetId('@someuser')).toBe('someuser')
  })

  it('is empty for an empty address', () => {
    expect(toMetaTargetId('')).toBe('')
  })
})

describe('isOpaqueMetaId', () => {
  it('accepts a namespaced BSUID', () => {
    expect(isOpaqueMetaId('CO.1008477715690681')).toBe(true)
  })

  it('accepts a LID-namespaced id', () => {
    expect(isOpaqueMetaId('LID.99887766')).toBe(true)
  })

  it('accepts a bare digit run too long to be a phone number', () => {
    expect(isOpaqueMetaId('1486998326437295')).toBe(true)
  })

  it('rejects a real phone number', () => {
    expect(isOpaqueMetaId('573167071066')).toBe(false)
  })

  it('rejects a short numeric id scraped out of a @lid display id', () => {
    expect(isOpaqueMetaId('123456')).toBe(false)
  })

  it('rejects an empty address', () => {
    expect(isOpaqueMetaId('')).toBe(false)
  })
})

describe('sendTextMessage recipient shapes', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(okResponse())
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('sends a phone number via "to" with preview_url disabled', async () => {
    await sendTextMessage({
      phoneNumberId: 'PNID',
      accessToken: 'TOKEN',
      to: '+57 316 707 1066',
      text: 'hola',
    })
    const body = sentBody(fetchMock)
    expect(body.to).toBe('573167071066')
    expect(body.recipient).toBeUndefined()
    expect(body.text).toEqual({ preview_url: false, body: 'hola' })
    expect(body.messaging_product).toBe('whatsapp')
    expect(body.recipient_type).toBe('individual')
    expect(body.context).toBeUndefined()
  })

  it('sends a namespaced BSUID as a bare numeric id in "to" (letters stripped)', async () => {
    await sendTextMessage({
      phoneNumberId: 'PNID',
      accessToken: 'TOKEN',
      to: 'CO.1008477715690681',
      text: 'hola',
    })
    const body = sentBody(fetchMock)
    // Meta rejects letters and dots in `to`; the digits are the real id.
    expect(body.to).toBe('1008477715690681')
    expect(body.recipient).toBeUndefined()
    expect(body.context).toBeUndefined()
  })

  it('supports the alternate "recipient" field as an explicit retry', async () => {
    await sendTextMessage({
      phoneNumberId: 'PNID',
      accessToken: 'TOKEN',
      to: 'CO.1008477715690681',
      text: 'hola',
      recipientField: 'recipient',
    })
    const body = sentBody(fetchMock)
    // Escape hatch keeps the address intact for Meta's alternate shape.
    expect(body.recipient).toBe('CO.1008477715690681')
    expect(body.to).toBeUndefined()
  })

  it('reaches the network for an @lid id instead of refusing it locally', async () => {
    // Regression guard for the production bug: a contact whose phone is
    // "unknown" must never be dropped by a local assertion. Meta is the
    // authority on whether the destination is deliverable.
    await sendTextMessage({
      phoneNumberId: 'PNID',
      accessToken: 'TOKEN',
      to: '123456@lid',
      text: 'se enviaría',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = sentBody(fetchMock)
    expect(body.to).toBe('123456')
  })

  it('still refuses only when there is no destination at all', async () => {
    await expect(
      sendTextMessage({ phoneNumberId: 'PNID', accessToken: 'TOKEN', to: '', text: 'x' }),
    ).rejects.toBeInstanceOf(InvalidRecipientError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers an unaddressable @lid id by quoting the inbound wamid', async () => {
    await sendTextMessage({
      phoneNumberId: 'PNID',
      accessToken: 'TOKEN',
      to: '123456@lid',
      text: 'respuesta IA',
      contextMessageId: 'wamid.HBgL_INBOUND',
    })
    const body = sentBody(fetchMock)
    expect(body.context).toEqual({ message_id: 'wamid.HBgL_INBOUND' })
    expect(body.text).toEqual({ preview_url: false, body: 'respuesta IA' })
  })

  it('logs the verbatim Meta error envelope under META_API_SEND_ERROR and META_API_REJECTED', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ error: { message: 'Invalid parameter', code: 100 } }),
    } as unknown as Response)

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      sendTextMessage({ phoneNumberId: 'PNID', accessToken: 'TOKEN', to: '573167071066', text: 'x' }),
    ).rejects.toThrow(/Invalid parameter/)

    const tagged = errorSpy.mock.calls.find(
      (c) => c[0] === 'META_API_SEND_ERROR:',
    )
    expect(tagged).toBeDefined()
    expect(JSON.parse(String(tagged![1]))).toEqual({
      error: { message: 'Invalid parameter', code: 100 },
    })

    // The EasyPanel-facing tag carries the HTTP status alongside the body.
    const rejected = errorSpy.mock.calls.find((c) => c[0] === 'META_API_REJECTED:')
    expect(rejected).toBeDefined()
    const parsed = JSON.parse(String(rejected![1])) as Record<string, unknown>
    expect(parsed.status).toBe(400)
    expect(parsed.response).toEqual({ error: { message: 'Invalid parameter', code: 100 } })
  })

  it('classifies a Meta recipient rejection so callers retry the other field', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          error: { message: 'Recipient phone number not in allowed list', code: 131009 },
        }),
    } as unknown as Response)

    const err = await sendTextMessage({
      phoneNumberId: 'PNID',
      accessToken: 'TOKEN',
      to: '1486998326437295',
      text: 'x',
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(MetaApiError)
    expect((err as MetaApiError).recipientInvalid).toBe(true)
  })
})