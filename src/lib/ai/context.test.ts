import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConversationContext } from './context'

/** Minimal fake matching the query chain in buildConversationContext:
 *  from().select().eq().in().order().limit() → { data, error }.
 *
 *  Records the `.in()` arguments so a test can assert which content
 *  types survive the filter — the tap regression lived exactly there. */
function fakeDb(
  rows: unknown[],
  seen: { inArgs: unknown[] } = { inArgs: [] }
): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    in: (_col: string, values: unknown) => {
      seen.inArgs.push(values)
      return chain
    },
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return chain as unknown as SupabaseClient
}

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    const rows = [
      { sender_type: 'customer', content_text: 'third' },
      { sender_type: 'agent', content_text: 'second' },
      { sender_type: 'customer', content_text: 'first' },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
  })

  it('treats bot messages as assistant', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_text: 'auto reply' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops empty / whitespace-only messages', async () => {
      const out = await buildConversationContext(
        fakeDb([
          { sender_type: 'customer', content_text: '   ' },
          { sender_type: 'customer', content_text: null },
          { sender_type: 'customer', content_text: 'real' },
        ]),
        'conv-1',
      )
      // A row that arrived with nothing to say still happened. It used to be
      // dropped here, which is how an uncaptioned photo left the model with no
      // idea the customer had sent anything. Rows are reversed into
      // chronological order by the builder, hence `real` first.
      expect(out).toEqual([
        { role: 'user', content: 'real' },
        { role: 'user', content: '[El usuario envió un mensaje de texto]' },
        { role: 'user', content: '[El usuario envió un mensaje de texto]' },
      ])
    })

  it('includes transcribed audio rows (voice notes) in the context', async () => {
    // The webhook stores the transcript on content_type='audio' rows.
    const out = await buildConversationContext(
      fakeDb([
        {
          sender_type: 'customer',
          content_type: 'audio',
          content_text: 'Quiero agendar una cita',
        },
        { sender_type: 'customer', content_type: 'text', content_text: 'hola' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([
      { role: 'user', content: 'hola' },
      { role: 'user', content: 'Quiero agendar una cita' },
    ])
  })

  it('reads a button / list tap as an ordinary user turn', async () => {
    // A tap on "Quiero información" is stored content_type='interactive'
    // with the tapped LABEL in content_text. It must reach the model as a
    // plain user message — filtered out, the bot was asked to answer a
    // tap it had never been told about.
    const out = await buildConversationContext(
      fakeDb([
        // Newest-first, as the DB returns it; the fn reverses it.
        {
          sender_type: 'customer',
          content_type: 'interactive',
          content_text: 'Quiero información',
          interactive_reply_id: 'WANT_INFO',
        },
        { sender_type: 'customer', content_type: 'text', content_text: 'hola' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([
      { role: 'user', content: 'hola' },
      { role: 'user', content: 'Quiero información' },
    ])
  })

  it('requests interactive and template rows from the DB', async () => {
    // Guards the filter itself. The `.in()` allowlist is what silently
    // dropped taps; asserting on it fails at the source rather than
    // only through a caller that happens to pass a tap through.
    const seen = { inArgs: [] as unknown[] }
    await buildConversationContext(fakeDb([], seen), 'conv-1')

    expect(seen.inArgs).toHaveLength(1)
    expect(seen.inArgs[0]).toEqual(
      expect.arrayContaining(['interactive', 'template'])
    )
  })
})
