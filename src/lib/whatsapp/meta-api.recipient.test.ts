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
})
