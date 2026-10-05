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
  resolveRecipient,
  recipientAddressQueue,
  latestInboundAnchorId,
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
// ============================================================
// One ladder, one queue, for every sender.
//
// The bug this covers: the AI could answer a contact known only by an
// opaque id while an operator sending the same thing from the INBOX could
// not. Two causes, both fixed in this module:
//   1. `resolveRecipient` ignored `wa_id` / `recipient_id`, so it could
//      resolve an address the projection had not even selected.
//   2. the AI's retry list was `isDialablePhone`-gated, so it could never
//      retry a BSUID or a handle - the very addresses that get rejected.
// ============================================================
describe('resolveRecipient - one ladder for all senders', () => {
  beforeEach(() => {
    mocks.fromAny.mockImplementation(() => {
      const b: Record<string, unknown> = {}
      const chain = () => b
      for (const m of ['select', 'eq', 'in', 'not', 'order']) b[m] = vi.fn(chain)
      b.limit = vi.fn(() => Promise.resolve({ data: [], error: null }))
      b.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }))
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: [], error: null })
      return b
    })
  })

  it('prefers a dialable number, unchanged', async () => {
    const r = await resolveRecipient(
      { id: 'c1', phone: '+57 312 218 2949' },
      'acct-1',
    )
    expect(r).toMatchObject({ to: '573122182949', source: 'phone', isPhone: true })
  })

  it('falls back to wa_id when no number exists anywhere', async () => {
    const r = await resolveRecipient(
      { id: 'c1', phone: null, wa_id: '5511999999999' },
      'acct-1',
    )
    expect(r.to).toBe('5511999999999')
    expect(r.isPhone).toBe(false)
  })

  it('falls back to recipient_id when wa_id and the BSUID are absent', async () => {
    const r = await resolveRecipient(
      { id: 'c1', phone: null, wa_user_id: null, recipient_id: '99887766' },
      'acct-1',
    )
    expect(r.to).toBe('99887766')
  })

  it('still resolves a @handle stored in the phone column', async () => {
    const r = await resolveRecipient({ id: 'c1', phone: '@tienda' }, 'acct-1')
    expect(r).toMatchObject({ to: '@tienda', source: 'username', isPhone: false })
  })

  it('recovers a real number from the contact own thread before any id', async () => {
    mocks.fromAny.mockImplementation((table: string) => {
      const rows =
        table === 'conversations'
          ? [{ id: 'conv-1' }]
          : table === 'messages'
            ? [{ sender_phone: '573001234567' }]
            : []
      const b: Record<string, unknown> = {}
      const chain = () => b
      for (const m of ['select', 'eq', 'in', 'not', 'order']) b[m] = vi.fn(chain)
      b.limit = vi.fn(() => Promise.resolve({ data: rows, error: null }))
      b.maybeSingle = vi.fn(() => Promise.resolve({ data: rows[0] ?? null, error: null }))
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null })
      return b
    })

    const r = await resolveRecipient(
      { id: 'c1', phone: 'CO.1008477715690681', wa_user_id: '1008477715690681' },
      'acct-1',
      'conv-1',
    )
    expect(r).toMatchObject({ to: '573001234567', source: 'recovered', isPhone: true })
  })
})

describe('recipientAddressQueue - shared by the AI and the manual sender', () => {
  beforeEach(() => {
    mocks.fromAny.mockImplementation((table: string) => {
      const rows = table === 'conversations' ? [{ id: 'conv-1' }] : []
      const b: Record<string, unknown> = {}
      const chain = () => b
      for (const m of ['select', 'eq', 'in', 'not', 'order']) b[m] = vi.fn(chain)
      b.limit = vi.fn(() => Promise.resolve({ data: rows, error: null }))
      b.maybeSingle = vi.fn(() => Promise.resolve({ data: rows[0] ?? null, error: null }))
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null })
      return b
    })
  })

  it('includes opaque ids, which the old AI-only queue filtered out', async () => {
    const queue = await recipientAddressQueue(
      {
        id: 'c1',
        phone: 'CO.1008477715690681',
        wa_user_id: '1008477715690681',
        wa_id: '5511999999999',
        recipient_id: '99887766',
        username: 'tienda',
      },
      'acct-1',
      'CO.1008477715690681',
      'conv-1',
    )

    expect(queue[0]).toBe('CO.1008477715690681')
    expect(queue).toContain('5511999999999')
    expect(queue).toContain('1008477715690681')
    expect(queue).toContain('99887766')
    expect(queue).toContain('@tienda')
  })

  it('de-duplicates, so an unchanged contact yields one entry', async () => {
    const queue = await recipientAddressQueue(
      { id: 'c1', phone: '573122182949' },
      'acct-1',
      '573122182949',
      'conv-1',
    )
    expect(queue).toEqual(['573122182949'])
  })

  it('reports a number recovered from history so it can be persisted', async () => {
    mocks.fromAny.mockImplementation((table: string) => {
      const rows =
        table === 'conversations'
          ? [{ id: 'conv-1' }]
          : table === 'messages'
            ? [{ sender_phone: '573001234567' }]
            : []
      const b: Record<string, unknown> = {}
      const chain = () => b
      for (const m of ['select', 'eq', 'in', 'not', 'order']) b[m] = vi.fn(chain)
      b.limit = vi.fn(() => Promise.resolve({ data: rows, error: null }))
      b.maybeSingle = vi.fn(() => Promise.resolve({ data: rows[0] ?? null, error: null }))
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null })
      return b
    })

    const onRecovered = vi.fn()
    const queue = await recipientAddressQueue(
      { id: 'c1', phone: 'CO.1008477715690681' },
      'acct-1',
      'CO.1008477715690681',
      'conv-1',
      { onRecovered },
    )

    // `primary` stays first; the recovered dialable number is the next thing to
    // try. (In the real flow `resolveRecipient` already prefers the recovered
    // number, so it arrives here as the primary.)
    expect(queue[0]).toBe('CO.1008477715690681')
    expect(queue).toContain('573001234567')
    expect(onRecovered).toHaveBeenCalledWith('573001234567')
  })
})

describe('latestInboundAnchorId', () => {
  function anchorDb(rows: unknown[]) {
    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['select', 'eq', 'not', 'order']) b[m] = vi.fn(chain)
    b.limit = vi.fn(() => Promise.resolve({ data: rows, error: null }))
    return { from: vi.fn(() => b) }
  }

  it('returns the newest inbound wamid', async () => {
    expect(
      await latestInboundAnchorId(anchorDb([{ message_id: 'wamid.NEW' }]) as never, 'conv-1'),
    ).toBe('wamid.NEW')
  })

  it('returns null when the thread has no anchored inbound', async () => {
    expect(await latestInboundAnchorId(anchorDb([]) as never, 'conv-1')).toBeNull()
    expect(await latestInboundAnchorId(anchorDb([]) as never, null)).toBeNull()
  })

  it('only ever reads customer messages in the given conversation', async () => {
    const db = anchorDb([{ message_id: 'wamid.NEW' }])
    await latestInboundAnchorId(db as never, 'conv-9')

    const builder = db.from() as unknown as {
      eq: { mock: { calls: unknown[][] } }
    }
    const eqCalls = builder.eq.mock.calls.map((c) => [c[0], c[1]])
    expect(eqCalls).toContainEqual(['conversation_id', 'conv-9'])
    expect(eqCalls).toContainEqual(['sender_type', 'customer'])
  })
})