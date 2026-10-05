import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  contactPhone,
  normalizeToE164,
  persistRecoveredAddress,
  recoverAddressesFromHistory,
  resolveBroadcastAddress,
} from './broadcast-address'
import type { Contact } from '@/types'

/**
 * Every case here is a regression guard for a defect that survived five
 * consecutive patch attempts, because none of it was covered by a test.
 * If one of these fails, broadcasts are being aimed at the wrong address
 * (or at nobody).
 */

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'contact-1',
    user_id: 'user-1',
    account_id: 'acc-1',
    phone: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Contact
}

describe('normalizeToE164', () => {
  it('keeps a stored E.164 number intact', () => {
    // THE primary bug: the old helper returned '' for anything that was
    // not exactly 10 or 11 digits, so a correctly-stored 12-digit
    // Colombian E.164 — the format every real contact has — was thrown
    // away and the recipient was reported undeliverable.
    expect(normalizeToE164('573121828949')).toBe('573121828949')
    expect(normalizeToE164('+57 312 182 8949')).toBe('573121828949')
    expect(normalizeToE164('57 312 182 8949')).toBe('573121828949')
  })

  it('adds the default country code to a bare 10-digit national number', () => {
    expect(normalizeToE164('3121828949')).toBe('573121828949')
    expect(normalizeToE164('(312) 182-8949')).toBe('573121828949')
  })

  it('does not double-prefix a number that already has a country code', () => {
    // 11 and 12 digit values carry their own country code and were
    // previously prefixed AGAIN, producing a 13-digit address pointing at
    // a different person.
    expect(normalizeToE164('57312182894')).toBe('57312182894')
    expect(normalizeToE164('573121828949')).toBe('573121828949')
  })

  it('refuses to build a number out of a username', () => {
    // Stripping non-digits BEFORE the phone-shape check is what turned a
    // handle into stray digits and aimed the campaign at a stranger.
    expect(normalizeToE164('@usuario')).toBeNull()
    expect(normalizeToE164('usuario')).toBeNull()
    // A handle whose digits alone look like a national number.
    expect(normalizeToE164('@usuario3121828949')).toBeNull()
  })

  it('refuses a BSUID', () => {
    expect(normalizeToE164('CO.1008477715690681')).toBeNull()
    expect(normalizeToE164('1008477715690681')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(normalizeToE164(null)).toBeNull()
    expect(normalizeToE164(undefined)).toBeNull()
    expect(normalizeToE164('   ')).toBeNull()
  })
})

describe('contactPhone', () => {
  it('prefers a usable contact.phone', () => {
    expect(contactPhone(contact({ phone: '573121828949' }))).toBe(
      '573121828949',
    )
  })

  it('falls back to wa_id when phone is unusable', () => {
    expect(
      contactPhone(contact({ phone: null, wa_id: '573121828949' })),
    ).toBe('573121828949')
  })

  it('never treats username or wa_user_id as a phone number', () => {
    // A broadcast `to` field takes a number. A BSUID there returns HTTP
    // 200 from Meta and silently drops the message.
    expect(
      contactPhone(contact({ username: '@usuario', wa_user_id: '1008477715690681' })),
    ).toBeNull()
  })

  it('tolerates a null contact', () => {
    expect(contactPhone(null)).toBeNull()
  })
})

/** Records the column list each `select()` asked for. */
interface QueryLog {
  selects: string[]
  messagesFilters: { column: string; value: string }[]
  contactUpdates: { id: string; patch: Record<string, unknown> }[]
}

/** Fake covering the chains `recoverAddressesFromHistory` and
 *  `persistRecoveredAddress` use:
 *  conversations: from().select().in()  → { data, error }
 *  messages:     from().select().in().not().order().limit() → { data, error }
 *  contacts:     from().update().eq()  → { error } */
function fakeDb(
  log: QueryLog,
  conversations: Array<{ id: string; contact_id: string }>,
  messages: Array<{ conversation_id: string; sender_phone: string | null }>,
  opts: {
    convError?: string
    msgError?: string
    updateError?: string
  } = {},
): SupabaseClient {
  const chain: Record<string, (...args: never[]) => unknown> = {
    from: (table: string) => {
      if (table === 'conversations') {
        return {
          select: (cols: string) => {
            log.selects.push(cols)
            return {
              in: () =>
                Promise.resolve({
                  data: opts.convError ? null : conversations,
                  error: opts.convError ? { message: opts.convError } : null,
                }),
            }
          },
        }
      }
      if (table === 'contacts') {
        return {
          update: (patch: Record<string, unknown>) => ({
            eq: (column: string, value: string) => {
              log.contactUpdates.push({ id: value, patch })
              void column
              return Promise.resolve({
                error: opts.updateError ? { message: opts.updateError } : null,
              })
            },
          }),
        }
      }
      return {
        select: (cols: string) => {
          log.selects.push(cols)
          const filters = log.messagesFilters
          const builder = {
            in: () => builder,
            not: (column: string) => {
              filters.push({ column, value: 'not-null' })
              return builder
            },
            order: () => builder,
            limit: () =>
              Promise.resolve({
                data: opts.msgError ? null : messages,
                error: opts.msgError ? { message: opts.msgError } : null,
              }),
          }
          return builder
        },
      }
    },
  }
  return chain as unknown as SupabaseClient
}

function newLog(): QueryLog {
  return { selects: [], messagesFilters: [], contactUpdates: [] }
}

describe('recoverAddressesFromHistory', () => {
  it('reads sender_phone — the only address column messages has', async () => {
    // The bug: the query selected `address`, `whatsapp_id` and `from`,
    // none of which exist on `messages`. PostgREST 400s the whole request,
    // `data` is null, and every @user recipient silently resolved to
    // nothing. Asserting the column list fails here, at the source.
    const log = newLog()
    await recoverAddressesFromHistory(
      fakeDb(log, [{ id: 'conv-1', contact_id: 'contact-1' }], []),
      [contact({ username: '@usuario' })],
    )

    const messagesSelect = log.selects.find((s) => s.includes('sender_phone'))
    expect(messagesSelect).toBe('conversation_id, sender_phone')
    expect(log.selects.join(' ')).not.toMatch(/whatsapp_id|\baddress\b|\bfrom\b/)
    // And it must exclude the NULL rows rather than trusting them.
    expect(log.messagesFilters).toEqual([
      { column: 'sender_phone', value: 'not-null' },
    ])
  })

  it('recovers the number an @user contact actually wrote from', async () => {
    const log = newLog()
    const recovered = await recoverAddressesFromHistory(
      fakeDb(
        log,
        [{ id: 'conv-1', contact_id: 'contact-1' }],
        [{ conversation_id: 'conv-1', sender_phone: '573121828949' }],
      ),
      [contact({ username: '@usuario', wa_user_id: '1008477715690681' })],
    )

    expect(recovered.get('contact-1')).toBe('573121828949')
  })

  it('skips conversations belonging to a different contact', async () => {
    // Isolation boundary: another contact's thread must never supply the
    // address, or the campaign goes to a different person.
    const log = newLog()
    const recovered = await recoverAddressesFromHistory(
      fakeDb(
        log,
        [{ id: 'conv-other', contact_id: 'contact-2' }],
        [{ conversation_id: 'conv-other', sender_phone: '573001234567' }],
      ),
      [contact({ username: '@usuario' })],
    )

    expect(recovered.size).toBe(0)
  })

  it('skips a BSUID recorded in sender_phone', async () => {
    // sender_phone snapshots whatever Meta disclosed, which for an
    // unregistered sender is an identifier — not a dialable number.
    const log = newLog()
    const recovered = await recoverAddressesFromHistory(
      fakeDb(
        log,
        [{ id: 'conv-1', contact_id: 'contact-1' }],
        [{ conversation_id: 'conv-1', sender_phone: 'CO.1008477715690681' }],
      ),
      [contact({ username: '@usuario' })],
    )

    expect(recovered.size).toBe(0)
  })

  it('does not query messages for a contact that already has a number', async () => {
    const log = newLog()
    const recovered = await recoverAddressesFromHistory(
      fakeDb(log, [], []),
      [contact({ phone: '573121828949' })],
    )

    expect(recovered.size).toBe(0)
    expect(log.selects).toHaveLength(0)
  })

  it('reports a failed conversation query instead of pretending history is empty', async () => {
    // A rejected query and a genuinely empty history look identical when the
    // error is discarded. That is what let a lookup failure present as a
    // data problem for five patch attempts.
    const log = newLog()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const recovered = await recoverAddressesFromHistory(
      fakeDb(log, [], [], { convError: 'permission denied' }),
      [contact({ username: '@usuario' })],
    )

    expect(recovered.size).toBe(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('reports a failed message query instead of returning nothing quietly', async () => {
    const log = newLog()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const recovered = await recoverAddressesFromHistory(
      fakeDb(
        log,
        [{ id: 'conv-1', contact_id: 'contact-1' }],
        [],
        { msgError: '400 bad request' },
      ),
      [contact({ username: '@usuario' })],
    )

    expect(recovered.size).toBe(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('resolveBroadcastAddress', () => {
  // THE bug that produced "No deliverable address for contact
  // (phone: 'unknown', username: '@jjuanpablo22222')": this module used to
  // accept numbers ONLY. The Inbox delivers to that same contact by handing
  // Meta its BSUID, so the contact was reachable all along and the broadcast
  // path was simply refusing to use the address that works.
  it('falls back to the BSUID when no number exists anywhere', () => {
    const resolved = resolveBroadcastAddress(
      contact({
        phone: 'unknown',
        username: '@jjuanpablo22222',
        wa_user_id: 'CO.1008477715690681',
      }),
    )
    expect(resolved).toEqual({ to: 'CO.1008477715690681', isPhone: false })
  })

  it('falls back to a bare numeric Meta id', () => {
    const resolved = resolveBroadcastAddress(
      contact({ phone: 'unknown', wa_id: '1486998326437295' }),
    )
    expect(resolved).toEqual({ to: '1486998326437295', isPhone: false })
  })

  it('falls back to the @handle last', () => {
    const resolved = resolveBroadcastAddress(
      contact({ phone: 'unknown', username: '@jjuanpablo22222' }),
    )
    expect(resolved).toEqual({ to: '@jjuanpablo22222', isPhone: false })
  })

  it('never sends to a placeholder', () => {
    // 'unknown' is truthy. Treating it as a phone would aim the campaign at
    // the literal string; treating it as an id would aim it at a stranger.
    expect(resolveBroadcastAddress(contact({ phone: 'unknown' }))).toBeNull()
    expect(resolveBroadcastAddress(contact({ phone: 'null' }))).toBeNull()
    expect(resolveBroadcastAddress(contact({ wa_id: 'unknown' }))).toBeNull()
    expect(
      resolveBroadcastAddress(contact({ wa_user_id: 'undefined' })),
    ).toBeNull()
  })

  it('prefers a real number over an identifier on the same row', () => {
    // An opaque id must not pre-empt a number sitting further down the list.
    const resolved = resolveBroadcastAddress(
      contact({ phone: '573121828949', wa_user_id: 'CO.1008477715690681' }),
    )
    expect(resolved).toEqual({ to: '573121828949', isPhone: true })
  })

  it('prefers wa_id over the BSUID', () => {
    const resolved = resolveBroadcastAddress(
      contact({
        phone: 'unknown',
        wa_id: '1486998326437295',
        wa_user_id: 'CO.1008477715690681',
      }),
    )
    expect(resolved?.to).toBe('1486998326437295')
  })

  it('uses a number recovered from the contact own history', () => {
    const resolved = resolveBroadcastAddress(
      contact({ phone: 'unknown', username: '@usuario' }),
      '573121828949',
    )
    expect(resolved).toEqual({ to: '573121828949', isPhone: true })
  })

  it('reports no address when the row holds nothing usable', () => {
    expect(resolveBroadcastAddress(contact({ phone: 'unknown' }))).toBeNull()
    expect(resolveBroadcastAddress(null)).toBeNull()
  })
})

describe('persistRecoveredAddress', () => {
  it('writes the recovered number onto contacts.phone', async () => {
    const log = newLog()
    const ok = await persistRecoveredAddress(
      fakeDb(log, [], []),
      'contact-1',
      '573121828949',
    )

    expect(ok).toBe(true)
    expect(log.contactUpdates).toEqual([
      { id: 'contact-1', patch: { phone: '573121828949' } },
    ])
  })

  it('never writes phone_normalized, which Postgres generates', async () => {
    // phone_normalized is GENERATED ALWAYS (migration 022); including it in
    // an update is rejected outright, so the write-back would always fail.
    const log = newLog()
    await persistRecoveredAddress(fakeDb(log, [], []), 'contact-1', '573121828949')

    expect(Object.keys(log.contactUpdates[0].patch)).toEqual(['phone'])
  })

  it('refuses to persist a BSUID into the number column', async () => {
    // A BSUID is a valid `to`, but `contacts.phone` is a number column with
    // a UNIQUE index on its normalized form. Writing an id there corrupts
    // the row and collides with the next contact owning that id.
    const log = newLog()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const ok = await persistRecoveredAddress(
      fakeDb(log, [], []),
      'contact-1',
      'CO.1008477715690681',
    )

    expect(ok).toBe(false)
    expect(log.contactUpdates).toHaveLength(0)
    warn.mockRestore()
  })

  it('tolerates a rejected write — the send must still proceed', async () => {
    // Persistence is an optimisation. A 23505 (the number already belongs to
    // another contact in the account) or an RLS denial must not fail the send.
    const log = newLog()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const ok = await persistRecoveredAddress(
      fakeDb(log, [], [], { updateError: 'duplicate key value violates unique constraint' }),
      'contact-1',
      '573121828949',
    )

    expect(ok).toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
