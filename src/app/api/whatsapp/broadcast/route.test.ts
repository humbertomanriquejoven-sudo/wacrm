import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Server-side address hydration in the broadcast route.
 *
 * The route used to derive every destination from the `phone` STRING the
 * client sent and never read `contacts` at all. For a row whose phone is the
 * literal 'unknown' — what the webhook writes when Meta discloses no number —
 * that produced no usable destination, the recipient was rejected, and the
 * send outcome depended on whatever the browser had cached. These tests pin
 * the fixed behaviour: the authoritative row is read at send time and
 * resolved with the same resolver the Inbox uses.
 */

const sendTemplateMessage = vi.fn()
const hydrateContacts = vi.fn()

const requireRole = vi.fn()
const decrypt = vi.fn(() => 'token')

vi.mock('@/lib/auth/account', () => ({
  requireRole: (...args: unknown[]) => requireRole(...args),
  toErrorResponse: () =>
    new Response(JSON.stringify({ error: 'boom' }), { status: 500 }),
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response('', { status: 429 }),
  RATE_LIMITS: { broadcast: { limit: 1, windowMs: 1 } },
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (...args: unknown[]) => decrypt(...(args as [])),
}))

vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: async () => ({
    row: { name: 't', language: 'es', components: [] },
    language: 'es',
    malformed: false,
  }),
}))

vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()
  return {
    ...actual,
    sendTemplateMessage: (...args: unknown[]) => sendTemplateMessage(...args),
  }
})

const CONFIG = { phone_number_id: 'pn-1', access_token: 'enc' }

/** Chainable stub: enough surface for whatsapp_config and contacts reads. */
function makeSupabase() {
  const selects: Array<{ table: string; columns: string }> = []

  const client = {
    from(table: string) {
      return {
        select(columns = '*') {
          selects.push({ table, columns })
          const chain = {
            eq: () => chain,
            in: () => chain,
            single: async () => ({ data: CONFIG, error: null }),
            then(
              onOk: (v: unknown) => unknown,
              onErr?: (e: unknown) => unknown,
            ) {
              return Promise.resolve(hydrateContacts(table)).then(onOk, onErr)
            },
          }
          return chain
        },
      }
    },
  }

  return { client, selects }
}

function postRequest(recipients: unknown[]) {
  return new Request('http://localhost/api/whatsapp/broadcast', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      recipients,
      template_name: 'primer_contacto_remodelacion',
      template_language: 'es',
    }),
  })
}

const HIDDEN_CONTACT = {
  id: 'contact-hidden',
  account_id: 'acct-1',
  phone: 'unknown',
  wa_id: '1486998326437295',
  recipient_id: '1486998326437295',
  wa_user_id: '1486998326437295',
  username: '@usuario',
}

async function run(recipients: unknown[], rows: unknown[] | null) {
  const { client, selects } = makeSupabase()
  hydrateContacts.mockResolvedValue({ data: rows, error: null })
  requireRole.mockResolvedValue({ supabase: client, accountId: 'acct-1', userId: 'u1' })

  const { POST } = await import('@/app/api/whatsapp/broadcast/route')
  const res = await POST(postRequest(recipients))
  return { res, body: await res.json(), selects }
}

beforeEach(() => {
  vi.clearAllMocks()
  sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.OK' })
})

describe('broadcast route — address hydration on the first attempt', () => {
  it('sends to the BSUID when the row phone is the "unknown" placeholder', async () => {
    // The production failure: phone = 'unknown', and the client only ever
    // supplied that string. Nothing reached Meta before.
    const { body } = await run(
      [{ phone: 'unknown', contact_id: 'contact-hidden', params: [] }],
      [HIDDEN_CONTACT],
    )

    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
    const sentTo = sendTemplateMessage.mock.calls[0][0].to as string
    expect(sentTo).toBe('1486998326437295')
    expect(sentTo).not.toBe('unknown')
    expect(sentTo).not.toContain('@')
    expect(body.sent).toBe(1)
    expect(body.failed).toBe(0)
  })

  it('selects every numerical-identity column, not just phone', async () => {
    // Requirement: the send-time query must bring wa_id, recipient_id and
    // wa_user_id, or the resolver has nothing to fall back to.
    const { selects } = await run(
      [{ phone: 'unknown', contact_id: 'contact-hidden', params: [] }],
      [HIDDEN_CONTACT],
    )

    const contactSelect = selects.find((s) => s.table === 'contacts')
    expect(contactSelect).toBeDefined()
    for (const column of ['phone', 'wa_id', 'recipient_id', 'wa_user_id']) {
      expect(contactSelect!.columns).toContain(column)
    }
  })

  it('hydrates every recipient in one query, not one query per recipient', async () => {
    await run(
      [
        { phone: 'unknown', contact_id: 'c1', params: [] },
        { phone: 'unknown', contact_id: 'c2', params: [] },
        { phone: 'unknown', contact_id: 'c3', params: [] },
      ],
      [
        { ...HIDDEN_CONTACT, id: 'c1' },
        { ...HIDDEN_CONTACT, id: 'c2' },
        { ...HIDDEN_CONTACT, id: 'c3' },
      ],
    )

    // Three recipients, still a single read of `contacts`. A per-recipient
    // SELECT would be an N+1 against Supabase on every campaign.
    const contactReads = hydrateContacts.mock.calls.filter(
      ([table]) => table === 'contacts',
    )
    expect(contactReads).toHaveLength(1)
    expect(sendTemplateMessage).toHaveBeenCalledTimes(3)
  })

  it('lets a visible number win over the ids on the same row', async () => {
    const { body } = await run(
      [{ phone: '573121828949', contact_id: 'contact-visible', params: [] }],
      [{ ...HIDDEN_CONTACT, id: 'contact-visible', phone: '573121828949' }],
    )

    expect(sendTemplateMessage.mock.calls[0][0].to).toBe('573121828949')
    expect(body.sent).toBe(1)
  })

  it('falls back wa_id -> recipient_id -> wa_user_id in strict order', async () => {
    await run(
      [{ phone: 'unknown', contact_id: 'c', params: [] }],
      [{ ...HIDDEN_CONTACT, id: 'c', wa_id: 'CO.aaa', recipient_id: 'CO.bbb', wa_user_id: 'ccc' }],
    )
    expect(sendTemplateMessage.mock.calls[0][0].to).toBe('CO.aaa')

    sendTemplateMessage.mockClear()
    await run(
      [{ phone: 'unknown', contact_id: 'c', params: [] }],
      [{ ...HIDDEN_CONTACT, id: 'c', wa_id: null, recipient_id: 'CO.bbb', wa_user_id: 'ccc' }],
    )
    expect(sendTemplateMessage.mock.calls[0][0].to).toBe('CO.bbb')

    sendTemplateMessage.mockClear()
    await run(
      [{ phone: 'unknown', contact_id: 'c', params: [] }],
      [{ ...HIDDEN_CONTACT, id: 'c', wa_id: null, recipient_id: null, wa_user_id: '333333333333333' }],
    )
    expect(sendTemplateMessage.mock.calls[0][0].to).toBe('333333333333333')
  })

  it('refuses to borrow the address of a contact in another account', async () => {
    const { body } = await run(
      [{ phone: 'unknown', contact_id: 'contact-foreign', params: [] }],
      [{ ...HIDDEN_CONTACT, id: 'contact-foreign', account_id: 'acct-2' }],
    )

    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(body.failed).toBe(1)
    expect(body.results[0].error).toContain('No valid phone or BSUID')
  })

  it('keeps the legacy phone-only path working for callers with no contact_id', async () => {
    const { body } = await run([{ phone: '573121828949', params: [] }], [])

    expect(sendTemplateMessage.mock.calls[0][0].to).toBe('573121828949')
    expect(body.sent).toBe(1)
  })

  it('never sends a bare @handle, even when that is all the row has', async () => {
    const { body } = await run(
      [{ phone: '@usuario', contact_id: 'c', params: [] }],
      [{ ...HIDDEN_CONTACT, id: 'c', phone: '@usuario', wa_id: null, recipient_id: null, wa_user_id: null }],
    )

    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(body.failed).toBe(1)
  })

  it('names the empty columns when nothing is deliverable', async () => {
    const { body } = await run(
      [{ phone: 'unknown', contact_id: 'c', params: [] }],
      [{ ...HIDDEN_CONTACT, id: 'c', wa_id: null, recipient_id: null, wa_user_id: null }],
    )

    // Without this the operator sees a bare "no address" and cannot tell
    // which column to repair.
    expect(body.results[0].error).toContain('wa_id=null')
    expect(body.results[0].error).toContain('recipient_id=null')
    expect(body.results[0].error).toContain('wa_user_id=null')
  })

  it('sends nothing and reports loudly when the identity query fails', async () => {
    const { client } = makeSupabase()
    hydrateContacts.mockImplementation(async (table: string) =>
      table === 'contacts'
        ? { data: null, error: { message: 'boom' } }
        : { data: CONFIG, error: null },
    )
    requireRole.mockResolvedValue({ supabase: client, accountId: 'acct-1', userId: 'u1' })

    const { POST } = await import('@/app/api/whatsapp/broadcast/route')
    const res = await POST(
      postRequest([{ phone: 'unknown', contact_id: 'c', params: [] }]),
    )

    // Silently degrading to phone-only resolution here is the exact bug
    // being fixed, so it must not be allowed to look like success.
    expect(res.status).toBe(500)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('echoes contact_id on every result so the caller can match without the address', async () => {
    // The caller no longer knows the address it sent — the server resolved it
    // — so a phone-keyed lookup cannot pair results with recipient rows.
    const { body } = await run(
      [{ phone: 'unknown', contact_id: 'contact-hidden', params: [] }],
      [HIDDEN_CONTACT],
    )
    expect(body.results[0].contact_id).toBe('contact-hidden')

    const failed = await run(
      [{ phone: 'unknown', contact_id: 'c', params: [] }],
      [{ ...HIDDEN_CONTACT, id: 'c', wa_id: null, recipient_id: null, wa_user_id: null }],
    )
    expect(failed.body.results[0].contact_id).toBe('c')
    expect(failed.body.results[0].status).toBe('failed')
  })

  it('prefers wa_user_id when the client sent a placeholder and no id', async () => {
    // The shape the browser used to drop: it could not resolve locally, so it
    // sent phone='unknown' with only a contact_id. The server must still put
    // a real address in `to` rather than forwarding the placeholder.
    const { body } = await run(
      [{ phone: 'unknown', contact_id: 'c', params: [] }],
      [
        {
          ...HIDDEN_CONTACT,
          id: 'c',
          wa_id: null,
          recipient_id: null,
          wa_user_id: '1486998326437295',
        },
      ],
    )

    expect(sendTemplateMessage.mock.calls[0][0].to).toBe('1486998326437295')
    expect(body.sent).toBe(1)
  })

  it('reports a failure instead of a silent success when nothing is addressable', async () => {
    const { body } = await run(
      [{ phone: 'unknown', contact_id: 'c', params: [] }],
      [
        {
          ...HIDDEN_CONTACT,
          id: 'c',
          phone: 'unknown',
          wa_id: null,
          recipient_id: null,
          wa_user_id: null,
        },
      ],
    )

    // Must never come back `sent` — that is what left the dashboard claiming
    // delivery for a message Meta was never asked to send.
    expect(body.sent).toBe(0)
    expect(body.failed).toBe(1)
    expect(body.results[0].status).toBe('failed')
  })
})
