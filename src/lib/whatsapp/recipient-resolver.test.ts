import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  isDialablePhone,
  isMetaIdentifier,
  toDialable,
  normalizeMetaIdentifier,
  normalizeUsername,
  identityFilterParts,
  isRecipientRejection,
  findRecoverablePhone,
} from '@/lib/whatsapp/recipient-resolver'
import { MetaApiError } from '@/lib/whatsapp/meta-api'

const mocks = vi.hoisted(() => ({
  fromContacts: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  or: vi.fn(),
  limit: vi.fn(),
  // The message-history fallback uses `conversations` then `messages`,
  // so `from` has to be table-aware.
  fromAny: vi.fn(),
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: mocks.fromAny,
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fromAny.mockImplementation((table: string) =>
    table === 'contacts' ? { select: mocks.select } : { select: mocks.select }
  )
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
  it('builds one filter per STRONG identity the payload carries', () => {
    const parts = identityFilterParts({
      phone: '573122182949',
      wa_user_id: '1008477715690681',
      username: 'humbertomanrique',
    })
    // Username is deliberately absent: matching on a handle could pull a
    // different phone number into this contact.
    expect(parts).toEqual([
      'phone.eq.573122182949',
      'wa_user_id.eq.1008477715690681',
    ])
  })

  it('never emits a username filter, even when only the handle is present', () => {
    const parts = identityFilterParts({ username: 'humbertomanrique' })
    expect(parts).toEqual([])
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

describe('findRecoverablePhone', () => {
  const ORPHAN = {
    id: 'contact-1',
    phone: 'CO.1008477715690681',
    name: 'Ana Ruiz',
    username: null,
    wa_user_id: '1008477715690681',
  }

  /**
   * Chainable stub keyed by table, so each query resolves to the rows that
   * table is meant to return. Written out rather than reused from the
   * contact-query mocks above because the history lookup issues two
   * different shapes (`conversations` then `messages`, the latter with
   * `.not` and `.order`).
   */
  function mockTables(tables: Record<string, unknown[]>) {
    mocks.fromAny.mockImplementation((table: string) => {
      const rows = tables[table] ?? []
      const b: Record<string, unknown> = {}
      const chain = () => b
      for (const m of ['select', 'eq', 'in', 'not', 'order']) b[m] = vi.fn(chain)
      b.limit = vi.fn(() => Promise.resolve({ data: rows, error: null }))
      b.maybeSingle = vi.fn(() =>
        Promise.resolve({ data: rows[0] ?? null, error: null }),
      )
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: rows, error: null })
      return b
    })
  }

  it('returns the contact own number when it is already dialable', async () => {
    const found = await findRecoverablePhone(
      { id: 'contact-1', phone: '573122182949' },
      'acct-1',
    )
    expect(found).toEqual({ phone: '573122182949', fromContactId: 'contact-1' })
    // No history lookup needed.
    expect(mocks.fromAny).not.toHaveBeenCalled()
  })

  it('returns null when nothing has a usable address', async () => {
    mockTables({})
    const found = await findRecoverablePhone(ORPHAN, 'acct-1')
    expect(found).toBeNull()
  })

  it('recovers a number from the contact own message history', async () => {
    mockTables({
      conversations: [{ id: 'conv-1' }],
      // Newest first: a BSUID, then the real number Meta used earlier.
      messages: [
        { sender_phone: 'CO.1008477715690681' },
        { sender_phone: '573122182949' },
      ],
    })

    const found = await findRecoverablePhone(ORPHAN, 'acct-1')
    expect(found).toEqual({ phone: '573122182949', fromContactId: null })
  })

  it('ignores BSUIDs stored on messages, since they are what it is escaping', async () => {
    mockTables({
      conversations: [{ id: 'conv-1' }],
      messages: [{ sender_phone: 'CO.1008477715690681' }],
    })

    const found = await findRecoverablePhone(ORPHAN, 'acct-1')
    expect(found).toBeNull()
  })

  it('does not consult history when the contact has no conversations', async () => {
    mockTables({ conversations: [], messages: [{ sender_phone: '573122182949' }] })

    const found = await findRecoverablePhone(ORPHAN, 'acct-1')
    expect(found).toBeNull()
  })

  it('confines the search to the given conversation', async () => {
    mockTables({
      conversations: [{ id: 'conv-9' }],
      messages: [{ sender_phone: '573122182949' }],
    })

    const found = await findRecoverablePhone(ORPHAN, 'acct-1', 'conv-9')
    expect(found).toEqual({ phone: '573122182949', fromContactId: null })
  })

  it('returns null when the given conversation does not belong to the contact', async () => {
    // `maybeSingle` resolves null, so no message rows are read.
    mockTables({
      conversations: [],
      messages: [{ sender_phone: '573122182949' }],
    })

    const found = await findRecoverablePhone(
      ORPHAN,
      'acct-1',
      'someone-elses-conv',
    )
    expect(found).toBeNull()
  })

  it('never reads numbers from other contacts', async () => {
    mockTables({ conversations: [{ id: 'conv-1' }], messages: [] })
    const found = await findRecoverablePhone(ORPHAN, 'acct-1')
    expect(found).toBeNull()
    const queriedTables = mocks.fromAny.mock.calls.map((c) => c[0])
    expect(queriedTables).not.toContain('contacts')
  })
})