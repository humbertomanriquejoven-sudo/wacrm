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
    expect(r.source).toBe('wa_id')
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

it('delivers a BSUID even when there is no wa_id (CASO C)', async () => {
    const r = await resolveBestRecipient({
      phone: 'unknown',
      wa_user_id: 'CO.999',
    })
    // El BSUID viaja en el campo `recipient` (campo `to` vacío es vǣlido
    // cuando el routing usa `recipient`). Se confirma que el identificador
    // se entrega y no se rechaza.
    expect(r.to).toBe('CO.999')
    expect(r.isBsuid).toBe(true)
    expect(r.source).toBe('bsuid')
  })

it('preserves full BSUID CO.1486998326437295 without truncation', async () => {
    const r = await resolveBestRecipient({
      phone: 'unknown',
      wa_user_id: 'CO.1486998326437295',
    })
    expect(r.to).toBe('CO.1486998326437295')
    expect(r.isBsuid).toBe(true)
    expect(r.source).toBe('bsuid')
  })

  it('preserves full BSUID CO.1008477715690681 without truncation', async () => {
    const r = await resolveBestRecipient({
      phone: 'unknown',
      wa_user_id: 'CO.1008477715690681',
    })
    expect(r.to).toBe('CO.1008477715690681')
    expect(r.isBsuid).toBe(true)
    expect(r.source).toBe('bsuid')
  })

  it('uses recipient_id when neither phone, wa_id nor BSUID is present', async () => {
    const r = await resolveBestRecipient({
      phone: 'unknown',
      recipient_id: '99887766',
    })
    expect(r.to).toBe('99887766')
  })

  it('prefers the FULL namespaced recipient_id over the stripped wa_user_id (CASO C)', async () => {
    // The webhook stores the normalized BSUID in `wa_user_id` and the full
    // `CO.…` value in `recipient_id`. Only the full value is accepted by Meta
    // (#131009), so it must win over the stripped identity value — never
    // surface the stripped digits as a `to` address.
    const r = await resolveBestRecipient({
      phone: 'unknown',
      wa_user_id: '1008477715690681',
      recipient_id: 'CO.1008477715690681',
    })
    expect(r.to).toBe('CO.1008477715690681')
    expect(r.isBsuid).toBe(true)
    expect(r.isPhone).toBe(false)
    expect(r.source).toBe('bsuid')
  })

  it('REFUSES a username — display data is never a destination (CASO C)', async () => {
    const r = await resolveBestRecipient({
      phone: 'unknown',
      username: 'someone',
    })
    expect(r.to).toBe('')
    expect(r.source).toBe('wa_id')
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