import { describe, expect, it } from 'vitest'

import {
  InvalidRecipientError,
  recipientAddressField,
  templateRecipientField,
} from '@/lib/whatsapp/meta-api'

describe('templateRecipientField', () => {
  // An opaque Meta id travels in `recipient`, NOT `to`: a BSUID placed in `to`
  // is answered by Meta with (#131009) "el formato del número de teléfono es
  // incorrecto" and the message is dropped (verified in production). The
  // namespaced form is kept INTACT — `recipient` is where Meta reads a BSUID.
  it('routes an opaque BSUID to "recipient", keeping the namespace', () => {
    expect(templateRecipientField('CO.1486998326437295')).toEqual({
      recipient: 'CO.1486998326437295',
    })
    expect(templateRecipientField('WAID.987654321')).toEqual({
      recipient: 'WAID.987654321',
    })
  })

  it('routes a long numeric id to "recipient"', () => {
    expect(templateRecipientField('1486998326437295')).toEqual({
      recipient: '1486998326437295',
    })
  })

  it('still normalizes a real number to E.164 digits in "to"', () => {
    expect(templateRecipientField('+57 304 455 6788')).toEqual({
      to: '573044556788',
    })
  })

  it('NEVER sends a handle — ESCENARIO C refuses it locally', () => {
    // A bare `@username` is display data, not an address. Both spellings
    // (with and without the leading '@') must be refused before any HTTP
    // request.
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
    // `to` wins when both are present, so they are mutually exclusive.
    for (const value of [
      '573044556788',
      'CO.1486998326437295',
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
    // `contacts.phone` is NOT NULL, so the webhook writes the literal string
    // 'unknown' for any sender Meta could not identify. Forwarding it puts
    // "unknown" in `to` and Meta answers with an opaque (#100) that looks
    // like a malformed API call rather than "no address on this contact".
    for (const value of ['unknown', 'UNKNOWN', ' undefined ', 'null', 'none', 'n/a']) {
      expect(templateRecipientField(value)).toEqual({ to: '' })
    }
  })

  it('routes every BSUID shape to "recipient" whatever namespace it carries', () => {
    // The exact forms `resolveBroadcastAddress` can return.
    expect(templateRecipientField('CO.1486098326437295')).toEqual({
      recipient: 'CO.1486098326437295',
    })
    expect(templateRecipientField('1486098326437295')).toEqual({
      recipient: '1486098326437295',
    })
    expect(templateRecipientField('1486098326437295@lid')).toEqual({
      recipient: '1486098326437295',
    })
  })
})

describe('recipientAddressField', () => {
  it('routes an E.164 phone number to "to" as digits', () => {
    expect(recipientAddressField('+57 304 455 6788')).toEqual({
      to: '573044556788',
    })
  })

  it('keeps a "CO."-prefixed BSUID intact and sends it as "recipient"', () => {
    expect(recipientAddressField('CO.1486998326437295')).toEqual({
      recipient: 'CO.1486998326437295',
    })
  })

  it('treats a long bare numeric id as a BSUID and sends it as "recipient"', () => {
    expect(recipientAddressField('1486998326437295')).toEqual({
      recipient: '1486998326437295',
    })
  })

  it('does not mangle a BSUID through phone sanitizers', () => {
    const field = recipientAddressField('WAID.987654321')
    expect(field).toEqual({ recipient: 'WAID.987654321' })
    expect(field.recipient).toContain('.')
  })

  it('NEVER sends an @handle — ESCENARIO C refuses it locally', () => {
    // THE "#100 Invalid parameter" bug: the fallback used `digits || value`,
    // so '@jjuanpablo22222' was sent as recipient:"22222" — a number we
    // invented from someone's display name, which Meta rejects. Now no
    // handle reaches Meta in any form.
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

  it('still accepts a BSUID in "recipient": digits or a namespaced numeric id', () => {
    // ESCENARIO C only bans handles — a real numeric BSUID (bare or
    // `CO.`/`WAID.`/`LID.`-prefixed) stays deliverable via `recipient`.
    expect(recipientAddressField('1486998326437295')).toEqual({
      recipient: '1486998326437295',
    })
    expect(recipientAddressField('WAID.987654321')).toEqual({
      recipient: 'WAID.987654321',
    })
    expect(recipientAddressField('LID.99887766')).toEqual({
      recipient: 'LID.99887766',
    })
  })

  it('never mutates a number into a different recipient', () => {
    // A short digit run is a real (if short) id; it must not gain or lose
    // digits on the way out.
    expect(recipientAddressField('22222')).toEqual({ recipient: '22222' })
  })

  it('prefers "to" for a dialable number and "recipient" for an id, never both', () => {
    const phone = recipientAddressField('573266778890')
    const bsuid = recipientAddressField('CO.9988776655443322')
    expect(phone.to).toBe('573266778890')
    expect(phone.recipient).toBeUndefined()
    expect(bsuid.recipient).toBe('CO.9988776655443322')
    expect(bsuid.to).toBeUndefined()
  })
})
