import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  isDialablePhone,
  isMetaIdentifier,
  toDialable,
  normalizeMetaIdentifier,
  normalizeUsername,
  identityFilterParts,
  isRecipientRejection,
} from '@/lib/whatsapp/recipient-resolver'
import { MetaApiError } from '@/lib/whatsapp/meta-api'

const mocks = vi.hoisted(() => ({
  fromContacts: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  or: vi.fn(),
  limit: vi.fn(),
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: mocks.fromContacts,
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fromContacts.mockReturnValue({ select: mocks.select })
  mocks.select.mockReturnValue({ eq: mocks.eq })
  mocks.eq.mockReturnValue({ or: mocks.or })
  mocks.or.mockReturnValue({ limit: mocks.limit })
  mocks.limit.mockResolvedValue({ data: [], error: null })
})

describe('phone vs Meta identifier classification', () => {
  it('accepts real E.164 numbers', () => {
    for (const phone of ['573122182949', '+573122182949', '1 555 123 4567']) {
      expect(isDialablePhone(phone)).toBe(true)
    }
    expect(toDialable('+57 312 218 2949')).toBe('573122182949')
  })

  it('rejects BSUIDs even though they are all digits', () => {
    // The whole point: normalizePhone strips the prefix, so a naive
    // digits-only check would pass these as phone numbers.
    expect(isDialablePhone('CO.1008477715690681')).toBe(false)
    expect(isDialablePhone('1008477715690681')).toBe(false)
    expect(isDialablePhone('WAID.99887766')).toBe(false)
    expect(toDialable('CO.1008477715690681')).toBeNull()
  })

  it('classifies long digit strings as Meta identifiers', () => {
    expect(isMetaIdentifier('CO.1008477715690681')).toBe(true)
    expect(isMetaIdentifier('1008477715690681')).toBe(true)
    expect(isMetaIdentifier('573122182949')).toBe(false)
  })

  it('strips the namespace prefix for storage', () => {
    expect(normalizeMetaIdentifier('CO.1008477715690681')).toBe('1008477715690681')
    expect(normalizeMetaIdentifier('1008477715690681')).toBe('1008477715690681')
    // A real number is not an identifier.
    expect(normalizeMetaIdentifier('573122182949')).toBeNull()
  })
})

describe('normalizeUsername', () => {
  it('always produces a single leading @', () => {
    expect(normalizeUsername('humberto')).toBe('@humberto')
    expect(normalizeUsername('@humberto')).toBe('@humberto')
    expect(normalizeUsername('@@humberto')).toBe('@humberto')
    expect(normalizeUsername('  humberto  ')).toBe('@humberto')
  })

  it('never produces a username from an identifier or a number', () => {
    expect(normalizeUsername('CO.1008477715690681')).toBeNull()
    expect(normalizeUsername('573122182949')).toBeNull()
    expect(normalizeUsername('Humberto Manrique')).toBeNull()
    expect(normalizeUsername('')).toBeNull()
  })
})

describe('identityFilterParts', () => {
  it('builds one filter per identity the payload carries', () => {
    const parts = identityFilterParts({
      phone: '573122182949',
      wa_user_id: '1008477715690681',
      username: 'humbertomanrique',
    })
    expect(parts).toEqual([
      'phone.eq.573122182949',
      'wa_user_id.eq.1008477715690681',
      'username.eq.@humbertomanrique',
    ])
  })

  it('omits a BSUID found sitting in the phone column', () => {
    // The legacy shape: phone holds the BSUID. It must be matched as
    // wa_user_id, never as a phone number.
    const parts = identityFilterParts({ phone: 'CO.1008477715690681' })
    expect(parts).toEqual(['wa_user_id.eq.1008477715690681'])
    expect(parts.some((p) => p.startsWith('phone.'))).toBe(false)
  })

  it('returns nothing when there is no usable identity', () => {
    expect(identityFilterParts({ phone: '', username: '' })).toEqual([])
  })
})

describe('isRecipientRejection', () => {
  it('flags Meta recipient complaints', () => {
    for (const code of [131009, 131026, 131047, 131051]) {
      expect(
        isRecipientRejection(
          new MetaApiError('boom', { status: 400, code }),
        ),
      ).toBe(true)
    }
    expect(
      isRecipientRejection(
        new MetaApiError('Recipient phone number not in allowed list', { status: 400 }),
      ),
    ).toBe(true)
  })

  it('does not flag template or permission failures', () => {
    // Retrying these against another address would double-send.
    expect(
      isRecipientRejection(
        new MetaApiError('Template name does not exist', { status: 400, code: 132001 }),
      ),
    ).toBe(false)
    expect(
      isRecipientRejection(new MetaApiError('WhatsApp not configured for this account', { status: 500 })),
    ).toBe(false)
  })
})