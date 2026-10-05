import { describe, expect, it } from 'vitest'

import { recipientAddressField } from '@/lib/whatsapp/meta-api'

describe('recipientAddressField', () => {
  it('routes an E.164 phone number to "to" as digits', () => {
    expect(recipientAddressField('+57 316 707 1066')).toEqual({
      to: '573167071066',
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
    const phone = recipientAddressField('573121828949')
    const bsuid = recipientAddressField('CO.1008477715690681')
    expect(phone.to).toBe('573121828949')
    expect(phone.recipient).toBeUndefined()
    expect(bsuid.recipient).toBe('CO.1008477715690681')
    expect(bsuid.to).toBeUndefined()
  })
})
