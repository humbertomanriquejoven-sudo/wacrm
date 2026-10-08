import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ from: () => ({}) }),
}))

import { resolveBestRecipient } from '@/lib/whatsapp/recipient-resolver'

// Every case below is destination-agnostic on purpose: no number, handle or
// id is special-cased. The resolver only reads what is on the row, so the
// same ordering serves a phone, a BSUID, a @lid display id and a username.
describe('resolveBestRecipient — generic identifier priority', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('prefers a dialable phone over every other identifier', async () => {
    const r = await resolveBestRecipient({
      phone: '+57 304 455 6788',
      wa_id: '123456789012345',
      wa_user_id: 'CO.999',
      recipient_id: '99887766',
      username: 'someone',
    })
    expect(r.to).toBe('573044556788')
    expect(r.isPhone).toBe(true)
    expect(r.source).toBe('phone')
  })

  it('falls back to wa_id when phone is unknown — the @lid sender case', async () => {
    const r = await resolveBestRecipient({
      phone: 'unknown',
      wa_id: '123456789012345',
    })
    expect(r.to).toBe('123456789012345')
    expect(r.isPhone).toBe(false)
    expect(r.source).toBe('bsuid')
  })

  it('normalizes a phone carrying + and spaces down to digits', async () => {
    const r = await resolveBestRecipient({ phone: '+57 304 455 6788' })
    expect(r.to).toBe('573044556788')
  })

  it('prefers wa_id over the BSUID', async () => {
    const r = await resolveBestRecipient({
      phone: 'unknown',
      wa_id: '123456789012345',
      wa_user_id: 'CO.999',
    })
    expect(r.to).toBe('123456789012345')
  })

  it('falls back to the BSUID when there is no wa_id', async () => {
    const r = await resolveBestRecipient({
      phone: 'unknown',
      wa_user_id: 'CO.999',
    })
    expect(r.to).toBe('CO.999')
  })

  it('uses recipient_id when neither phone, wa_id nor BSUID is present', async () => {
    const r = await resolveBestRecipient({
      phone: 'unknown',
      recipient_id: '99887766',
    })
    expect(r.to).toBe('99887766')
  })

  it('uses the username as the last resort', async () => {
    const r = await resolveBestRecipient({
      phone: 'unknown',
      username: 'someone',
    })
    expect(r.to).toBe('@someone')
    expect(r.source).toBe('username')
  })

  it('treats a bare digit-run stored in phone as an opaque id, not a number', async () => {
    // A 16-digit run is a BSUID/LID; coercing it to `to` would be a fake
    // phone number and Meta would answer 200 while dropping the message.
    const r = await resolveBestRecipient({ phone: '1486998326437295' })
    expect(r.to).toBe('1486998326437295')
    expect(r.isPhone).toBe(false)
  })

  it('returns an empty address when nothing is resolvable', async () => {
    const r = await resolveBestRecipient({ phone: 'unknown' })
    expect(r.to).toBe('')
    expect(r.isPhone).toBe(false)
  })

  it('tolerates a null contact', async () => {
    const r = await resolveBestRecipient(null)
    expect(r.to).toBe('')
  })
})