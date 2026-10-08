import { describe, expect, it } from 'vitest'

import { recipientAddressField, templateRecipientField } from '@/lib/whatsapp/meta-api'

describe('templateRecipientField', () => {
  // A template addresses an opaque id through `to`, like the Inbox's
  // sendTextMessage. Using `recipient` here is what produced
  // "(#100) Invalid parameter".
  it('puts an opaque BSUID in "to" with the namespace stripped', () => {
    expect(templateRecipientField('CO.1486998326437295')).toEqual({
      to: '1486998326437295',
    })
    expect(templateRecipientField('WAID.987654321')).toEqual({ to: '987654321' })
  })

  it('puts a long numeric id in "to" unchanged', () => {
    expect(templateRecipientField('1486998326437295')).toEqual({
      to: '1486998326437295',
    })
  })

  it('still normalizes a real number to E.164 digits', () => {
    expect(templateRecipientField('+57 304 455 6788')).toEqual({
      to: '573044556788',
    })
  })

  it('never reduces a handle to the digits it happens to contain', () => {
    // toMetaTargetId returns digits only, so applying it to a handle
    // manufactures a number out of someone's display name.
    expect(templateRecipientField('@jjuanpablo22222')).toEqual({
      to: 'jjuanpablo22222',
    })
    expect(templateRecipientField('jjuanpablo22222')).toEqual({
      to: 'jjuanpablo22222',
    })
  })

  it('never emits a "recipient" key', () => {
    // `to` wins when both are present, so mixing them is how the two
    // shapes drifted apart in the first place.
    for (const value of [
      '573044556788',
      'CO.1486998326437295',
      '1486998326437295',
      '@jjuanpablo22222',
    ]) {
      expect(templateRecipientField(value).recipient).toBeUndefined()
      expect(templateRecipientField(value).to).toBeTruthy()
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

  it('reduces a BSUID to its digits whatever namespace it carries', () => {
    // The exact forms `resolveBroadcastAddress` can return, and the shape
    // Meta requires in `to`.
    expect(templateRecipientField('CO.1486098326437295').to).toBe('1486098326437295')
    expect(templateRecipientField('1486098326437295').to).toBe('1486098326437295')
    expect(templateRecipientField('1486098326437295@lid').to).toBe('1486098326437295')
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

  it('never reduces an @handle to the digits it happens to contain', () => {
    // THE "#100 Invalid parameter" bug: the fallback used `digits || value`,
    // so '@jjuanpablo22222' was sent as recipient:"22222" — a number we
    // invented from someone's display name, which Meta rejects.
    expect(recipientAddressField('@jjuanpablo22222')).toEqual({
      recipient: '@jjuanpablo22222',
    })
    expect(recipientAddressField('jjuanpablo22222')).toEqual({
      recipient: 'jjuanpablo22222',
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
