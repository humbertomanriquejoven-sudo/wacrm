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
 *  messages:     from().select().in().order().limit() → { data, error }
 *  contacts:     from().update().eq()  → { error } */
function fakeDb(
  log: QueryLog,
  conversations: Array<{ id: string; contact_id: string }>,
messages: Array<{
    conversation_id: string
    sender_phone: string | null
    sender_type?: string
    raw_meta_payload?: unknown
  }>,
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
          // Rows are filtered here rather than server-side, so the
          // `sender_type = 'customer'` guard is genuinely exercised: an
          // 'agent' row must never yield an address.
          let rows = messages
          const builder = {
            in: () => builder,
            eq: (column: string, value: string) => {
              if (column === 'sender_type') {
                rows = rows.filter((m) => (m.sender_type ?? 'customer') === value)
              }
              return builder
            },
            order: () => builder,
            limit: () =>
              Promise.resolve({
                data: opts.msgError ? null : rows,
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
  it('ignores outbound rows, whose sender_phone is ours not the contact', async () => {
    // The newest row in a thread is usually OUR reply. Without the
    // sender_type guard a broadcast could resolve a contact's destination to
    // the number sending it.
    const log = newLog()
    const recovered = await recoverAddressesFromHistory(
      fakeDb(
        log,
        [{ id: 'cv-1', contact_id: 'c-1' }],
        [
          {
            conversation_id: 'cv-1',
            sender_phone: '15550001111',
            sender_type: 'agent',
          },
          {
            conversation_id: 'cv-1',
            sender_phone: '15552223333',
            sender_type: 'customer',
          },
        ],
      ),
      [{ id: 'c-1' } as never],
    )

    expect(recovered.get('c-1')).toBe('15552223333')
  })

  it('yields nothing when the thread holds only our own messages', async () => {
    const log = newLog()
    const recovered = await recoverAddressesFromHistory(
      fakeDb(log, [{ id: 'cv-1', contact_id: 'c-1' }], [
        {
          conversation_id: 'cv-1',
          sender_phone: '15550001111',
          sender_type: 'agent',
        },
      ]),
      [{ id: 'c-1' } as never],
    )

    expect(recovered.has('c-1')).toBe(false)
  })

  it('extracts a BSUID from sender_phone on an inbound message from a handle contact', async () => {
    // The tier-C path end to end. The contact row holds only a handle; the
    // numerical id lives on the message they wrote.
    const log = newLog()
    const contactRow = contact({ phone: 'unknown', username: '@jjuanpablo22222' })
    const recovered = await recoverAddressesFromHistory(
      fakeDb(
        log,
        [{ id: 'cv-1', contact_id: 'contact-1' }],
        [
          {
            conversation_id: 'cv-1',
            sender_phone: '1486998326437295',
            sender_type: 'customer',
          },
        ],
      ),
      [contactRow],
    )

    const resolved = resolveBroadcastAddress(
      contactRow,
      recovered.get('contact-1'),
    )
    expect(resolved).toEqual({ to: '1486998326437295', isPhone: false })
  })

  it('falls back to the raw webhook payload when sender_phone is null', async () => {
    // Meta sometimes sends the id only inside the message payload. Without
    // this the handle contact stays undeliverable.
    const log = newLog()
    const contactRow = contact({ phone: 'unknown', username: '@jjuanpablo22222' })
    const recovered = await recoverAddressesFromHistory(
      fakeDb(
        log,
        [{ id: 'cv-1', contact_id: 'contact-1' }],
        [
          {
            conversation_id: 'cv-1',
            sender_phone: null,
            sender_type: 'customer',
            raw_meta_payload: {
              entry: [{ changes: [{ value: { messages: [{ from: '1486998326437295' }] } }] }],
            },
          },
        ],
      ),
      [contactRow],
    )

    expect(recovered.get('contact-1')).toBe('1486998326437295')
  })
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

    // `raw_meta_payload` (migration 052) is real and is consulted as a last
    // resort, so it is the only addition to the original two columns. The
    // NULL rows are no longer filtered out in SQL because a row with a null
    // `sender_phone` can still carry the identifier in its payload.
    const messagesSelect = log.selects.find((s) => s.includes('sender_phone'))
    expect(messagesSelect).toBe(
      'conversation_id, sender_phone, raw_meta_payload',
    )
    expect(log.selects.join(' ')).not.toMatch(/whatsapp_id|\baddress\b/)
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

it('recovers a BSUID recorded in sender_phone', async () => {
    // Previously this was skipped: `toDialable` alone rejected every
    // identifier, so a contact whose only address is a BSUID resolved to
    // nothing and was stamped undeliverable. A BSUID is a real `to` value
    // for Meta, so it is now recovered like a number.
    const log = newLog()
    const recovered = await recoverAddressesFromHistory(
      fakeDb(
        log,
        [{ id: 'conv-1', contact_id: 'contact-1' }],
        [{ conversation_id: 'conv-1', sender_phone: '1486998326437295' }],
      ),
      [contact({ username: '@usuario' })],
    )

    expect(recovered.get('contact-1')).toBe('1486998326437295')
  })

  it('recovers the BSUID nested in a stored webhook payload', async () => {
    // sender_phone was null for this sender, but migration 052 kept the raw
    // entry, which is where Meta discloses the id.
    const log = newLog()
    const recovered = await recoverAddressesFromHistory(
      fakeDb(
        log,
        [{ id: 'conv-1', contact_id: 'contact-1' }],
        [
          {
            conversation_id: 'conv-1',
            sender_phone: null,
            raw_meta_payload: {
              messages: [
                {
                  from: '1486998326437295',
                  contacts: [{ profile: { name: 'Juan' } }],
                },
              ],
            },
          },
        ],
      ),
      [contact({ phone: 'unknown', username: '@usuario' })],
    )

    expect(recovered.get('contact-1')).toBe('1486998326437295')
  })

  it('never invents an address from a payload holding no identifier', async () => {
    // A display name and a phone_number_id are not destinations. Returning
    // one would aim the campaign at an arbitrary number.
    const log = newLog()
    const recovered = await recoverAddressesFromHistory(
      fakeDb(
        log,
        [{ id: 'conv-1', contact_id: 'contact-1' }],
        [
          {
            conversation_id: 'conv-1',
            sender_phone: null,
            raw_meta_payload: {
              display_phone: '593123456789',
              profile: { name: 'Juan Pablo' },
              metadata: { display_phone_number: '593123456789' },
            },
          },
        ],
      ),
      [contact({ phone: 'unknown', username: '@usuario' })],
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

it('never uses a bare @handle as the destination', () => {
    // Meta rejects a text handle in `to` with "(#100) Invalid parameter",
    // and adding `context.message_id` does NOT change that: quoting makes the
    // send a reply, it does not make the handle addressable. Campaign 3 sent
    // it bare and failed; campaign 4 shipped it as a quoted reply and it
    // still failed. The handle is a display detail only.
    expect(
      resolveBroadcastAddress(
        contact({ phone: 'unknown', username: '@jjuanpablo22222' }),
      ),
    ).toBeNull()
  })

  it('sends to the numerical Meta id recovered from the inbound message', () => {
    // Tier C, done correctly. For a contact known only by @handle, Meta's
    // webhook still carried a numerical id on the message they wrote. That
    // id — not the handle — is what belongs in `to`.
    expect(
      resolveBroadcastAddress(
        contact({ phone: 'unknown', username: '@jjuanpablo22222' }),
        '1486998326437295',
      ),
    ).toEqual({ to: '1486998326437295', isPhone: false })
  })

  it('accepts a namespaced id recovered from the inbound message', () => {
    expect(
      resolveBroadcastAddress(
        contact({ phone: 'unknown', username: '@jjuanpablo22222' }),
        'CO.1008477715690681',
      ),
    ).toEqual({ to: 'CO.1008477715690681', isPhone: false })
  })

  it('prefers a real number recovered over the contact row identifiers', () => {
    // A recovered dialable number is still the strongest signal.
    expect(
      resolveBroadcastAddress(
        contact({ phone: 'unknown', wa_user_id: 'CO.1008477715690681' }),
        '573121828949',
      ),
    ).toEqual({ to: '573121828949', isPhone: true })
  })

  it('is null when neither the row nor the history yields a number (tier D)', () => {
    expect(
      resolveBroadcastAddress(contact({ phone: 'unknown' })),
    ).toBeNull()
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

