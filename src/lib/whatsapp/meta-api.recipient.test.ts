import { describe, expect, it } from 'vitest'

import {
  InvalidRecipientError,
  recipientAddressField,
  templateRecipientField,
} from '@/lib/whatsapp/meta-api'

// CASO A/B/C recipient engine:
//   A. a dialable E.164 number travels in `to`;
//   B. a numeric opaque wa_id (the canonical privacy-shielded id) travels in
//      `to` too — the send path anchors it with `context.message_id`;
//   C. a namespaced BSUID (`CO.`/`WAID.`/`LID.`) is an IDENTITY marker that
//      must travel in Meta's `recipient` field (`to` omitted), needing NO
//      anchor. Only an `@handle` is refused (#100), and a bare placeholder
//      like "unknown" is stopped locally instead of silently dropped.

describe('templateRecipientField', () => {
  it('routes a namespaced BSUID to "recipient" (CASO C)', () => {
    expect(templateRecipientField('CO.1486998326437295')).toEqual({
      recipient: 'CO.1486998326437295',
    })
    expect(templateRecipientField('WAID.987654321')).toEqual({
      recipient: 'WAID.987654321',
    })
    expect(templateRecipientField('LID.99887766')).toEqual({
      recipient: 'LID.99887766',
    })
    // CASO C: `to` must be OMITTED entirely when recipient is used
    const field = templateRecipientField('CO.1486998326437295')
    expect(field.to).toBeUndefined()
    expect(Boolean(field.to) && Boolean(field.recipient)).toBe(false)
  })

  it('routes a long numeric opaque wa_id to "to" (CASO B)', () => {
    expect(templateRecipientField('1486998326437295')).toEqual({
      to: '1486998326437295',
    })
  })

  it('routes a short digit run to "to" too — an opaque wa_id, not a phone', () => {
    expect(templateRecipientField('22222')).toEqual({ to: '22222' })
  })

  it('normalizes a real number to E.164 digits in "to" (CASO A)', () => {
    expect(templateRecipientField('+57 304 455 6788')).toEqual({
      to: '573044556788',
    })
  })

  it('NEVER sends a handle — ESCENARIO C refuses it locally', () => {
    expect(() => templateRecipientField('@jjuanpablo22222')).toThrow(
      InvalidRecipientError
    )
    expect(() => templateRecipientField('jjuanpablo22222')).toThrow(
      InvalidRecipientError
    )
    expect(() => templateRecipientField('@acme.store')).toThrow(
      InvalidRecipientError
    )
  })

  it('never emits BOTH "to" and "recipient" at once', () => {
    // Delivered shapes are always a single `to`.
    for (const value of [
      '573044556788',
      '1486998326437295',
      '1486998326437295@lid',
      '22222',
    ]) {
      const field = templateRecipientField(value)
      expect(Boolean(field.to) && Boolean(field.recipient)).toBe(false)
      expect(field.to || field.recipient).toBeTruthy()
    }
  })

  it('refuses a placeholder instead of sending it to Meta', () => {
    for (const value of ['unknown', 'UNKNOWN', ' undefined ', 'null', 'none', 'n/a']) {
      expect(templateRecipientField(value)).toEqual({ to: '' })
    }
  })

  it('strips an @lid suffix and addresses the numeric wa_id (CASO B)', () => {
    expect(templateRecipientField('1486098326437295@lid')).toEqual({
      to: '1486098326437295',
    })
  })
})

describe('recipientAddressField', () => {
  it('routes an E.164 phone number to "to" as digits', () => {
    expect(recipientAddressField('+57 304 455 6788')).toEqual({
      to: '573044556788',
    })
  })

  it('routes a namespaced BSUID to "recipient" (CASO C), omitting "to"', () => {
    const field = recipientAddressField('CO.1486998326437295')
    expect(field.recipient).toBe('CO.1486998326437295')
    expect(field.to).toBeUndefined()
    // Rule: never put "CO." in the `to` field when recipient is used
  })

  it('treats a long bare numeric id as an opaque wa_id and sends it in "to"', () => {
    expect(recipientAddressField('1486998326437295')).toEqual({
      to: '1486998326437295',
    })
  })

  it('routes every namespaced BSUID to "recipient" (CASO C)', () => {
    expect(recipientAddressField('WAID.987654321')).toEqual({
      recipient: 'WAID.987654321',
    })
    expect(recipientAddressField('LID.99887766')).toEqual({
      recipient: 'LID.99887766',
    })
  })

  it('NEVER sends an @handle — ESCENARIO C refuses it locally', () => {
    expect(() => recipientAddressField('@jjuanpablo22222')).toThrow(
      InvalidRecipientError
    )
    expect(() => recipientAddressField('jjuanpablo22222')).toThrow(
      InvalidRecipientError
    )
    expect(() => recipientAddressField('@acme.store')).toThrow(
      InvalidRecipientError
    )
  })

  it('never mutates a short numeric id into a different recipient', () => {
    expect(recipientAddressField('22222')).toEqual({ to: '22222' })
  })

  it('always uses "to" for a dialable number and for an opaque wa_id', () => {
    const phone = recipientAddressField('573266778890')
    const opaque = recipientAddressField('1486998326437295')
    expect(phone.to).toBe('573266778890')
    expect(phone.recipient).toBeUndefined()
    expect(opaque.to).toBe('1486998326437295')
    expect(opaque.recipient).toBeUndefined()
  })
})
