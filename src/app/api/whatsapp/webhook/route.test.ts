import { describe, it, expect, vi, beforeEach } from 'vitest'

// Shared, hoisted state the module mocks close over. Reset per test.
const h = vi.hoisted(() => ({
  runAutomationsForTrigger: vi.fn(),
  dispatchInboundToFlows: vi.fn(),
  dispatchInboundToAiReply: vi.fn(),
  dispatchWebhookEvent: vi.fn(),
  state: {
    // Result the message upsert's .select() resolves to. A genuine insert
    // returns the row; a replayed delivery conflicts and returns [].
    messageUpsertResult: [{ id: 'msg-1' }] as { id: string }[],
    priorCustomerMsgCount: 0,
    /** Row `lookupInternalIdByMetaId` resolves for a `context.id`. */
    replyContextParent: null as { id: string } | null,
    conversation: { id: 'conv-1', unread_count: 0, account_id: 'acc-1' },
    upsertCalls: [] as { row: Record<string, unknown>; options: unknown }[],
    rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
    afterCallbacks: [] as (() => Promise<void> | void)[],
    automationStarted: 0,
    automationCompleted: 0,
    /** whatsapp_config.mirror_inbound_media for the matched row (#466). */
    mirrorInboundMedia: true as boolean | undefined,
    /** Objects the inbound-media mirror pushed into chat-media. */
    storageUploads: [] as {
      bucket: string
      path: string
      options: { contentType?: string }
    }[],
    /** Error the next storage upload resolves with, if any. */
    storageUploadError: null as { message: string } | null,
    /** findExistingContact return value (caller-configurable per test). */
    existingContactResult: null as {
      id: string
      name: string | null
      phone: string
    } | null,
    /** Patches applied via contacts.update. */
    contactUpdateCalls: [] as { id?: unknown; patch: Record<string, unknown> }[],
    /** Rows inserted via contacts.insert. */
    contactInsertCalls: [] as Record<string, unknown>[],
    /** Row returned by contacts.insert().single(). */
    contactsInsertResponse: null as Record<string, unknown> | null,
    /** Row returned by the BSUID / username exact-match lookups. */
    bsuidLookupResponse: null as Record<string, unknown> | null,
    /** Rows whose `phone` wrongly holds a 'CO.'-prefixed BSUID. */
    bsuidPhoneContacts: [] as Array<Record<string, unknown>>,
    /** Rows returned by the sibling-identity phone lookup. */
    siblingPhoneCandidates: [] as Array<Record<string, unknown>>,
    /** Rows purgeEmptyPhoneContacts() considers orphaned. */
    emptyPhoneContacts: [] as Record<string, unknown>[],
    /** Transcripts written back onto messages rows ('id' → patch). */
    messageTranscriptUpdates: [] as {
      id: unknown
      patch: Record<string, unknown>
    }[],
    /** conversation-list last_message_text refreshes after transcription. */
    conversationSummaryUpdates: [] as {
      id: unknown
      patch: Record<string, unknown>
    }[],
  },
}))

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => {
    h.state.afterCallbacks.push(cb)
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, init }),
  },
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      switch (table) {
        case 'whatsapp_config':
          return {
            select: () => ({
              eq: () =>
                Promise.resolve({
                  data: [
                    {
                      account_id: 'acc-1',
                      user_id: 'user-1',
                      phone_number_id: 'pn-1',
                      access_token: 'enc',
                      mirror_inbound_media: h.state.mirrorInboundMedia,
                    },
                  ],
                  error: null,
                }),
            }),
          }
        case 'conversations':
          // findOrCreateConversation: select().eq().eq().order().limit()
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () =>
                      Promise.resolve({
                        data: [h.state.conversation],
                        error: null,
                      }),
                  }),
                }),
              }),
            }),
            // Post-transcription last_message_text refresh.
            update: (patch: Record<string, unknown>) => ({
              eq: (_col: string, value: unknown) => {
                h.state.conversationSummaryUpdates.push({ id: value, patch })
                return Promise.resolve({ data: null, error: null })
              },
            }),
          }
        case 'broadcast_recipients':
          // flagBroadcastReplyIfAny: select().eq().eq().in().order().limit()
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  in: () => ({
                    order: () => ({
                      limit: () =>
                        Promise.resolve({ data: [], error: null }),
                    }),
                  }),
                }),
              }),
            }),
          }
        case 'contacts':
          return {
            select: () => {
              // `eq()` is called twice with different columns and the
              // answer must depend on WHICH column: findOrCreateContact
              // queries by `wa_user_id` (step 1) and by `username` (step 3),
              // both through the same `.eq().eq().limit()` shape. Filter the
              // configured row by the second filter so a `wa_user_id`
              // mismatch doesn't masquerade as a username match.
              let secondFilter: { column: string; value: unknown } | null = null
              const secondEqResult = {
                limit: (n: number) =>
                  Promise.resolve({
                    data: h.state.bsuidLookupResponse
                      ? [
                          String(h.state.bsuidLookupResponse[secondFilter!.column]) ===
                          String(secondFilter!.value)
                            ? h.state.bsuidLookupResponse
                            : null,
                        ]
                          .filter(Boolean)
                          .slice(0, n)
                      : [],
                    error: null,
                  }),
                then: (
                  resolve: (v: unknown) => unknown,
                  reject?: (e: unknown) => unknown,
                ) =>
                  Promise.resolve({
                    data: [],
                    error: null,
                  }).then(resolve, reject),
              }
              return {
                // repairBsuidPhoneContacts: select(...).like('phone', 'CO.%')
                like: (column: string, pattern: string) => {
                  // Translate SQL LIKE wildcards: `_` matches one
                  // character, `%` matches the rest of the string. The
                  // repair helper uses '______________%' to catch 15+
                  // digit phones, so the mock has to honour that.
                  const re = new RegExp(
                    '^' +
                      pattern
                        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                        .replace(/%/g, '.*')
                        .replace(/_/g, '.') +
                      '$',
                  )
                  const rows = (h.state.bsuidPhoneContacts ?? []).filter((row) =>
                    re.test(String(row[column] ?? '')),
                  )
                  // sanitizeStoredPhones chains .like('phone','@%').limit(n)
                  return Object.assign(
                    Promise.resolve({ data: rows, error: null }),
                    { limit: () => Promise.resolve({ data: rows, error: null }) },
                  )
                },
                // purgeEmptyPhoneContacts: select(...).or('phone.is.null,phone.eq.')
                // sanitizeStoredPhones chains .or(...).limit(n) — support both.
                or: () =>
                  Object.assign(
                    Promise.resolve({
                      data: h.state.emptyPhoneContacts ?? [],
                      error: null,
                    }),
                    {
                      limit: () =>
                        Promise.resolve({ data: [], error: null }),
                    },
                  ),
                // `eq` has two consumers with different tails: the BSUID /
                // username exact lookups chain `.eq().eq()` (resolves via
                // `then`), while findRealNumberForIdentity does
                // `.eq(account_id).or(clauses).limit(n)`. Support both.
                eq: () => ({
                  eq: (col2: string, val2: unknown) => {
                    secondFilter = { column: col2, value: val2 }
                    return secondEqResult
                  },
                  or: () => ({
                    limit: (n: number) =>
                      Promise.resolve({
                        data: (h.state.siblingPhoneCandidates ?? []).slice(0, n),
                        error: null,
                      }),
                  }),
                }),
              }
            },
            // update(...).eq('id', x).eq('account_id', y) — the repair helper scopes
            // by account, findOrCreateContact scopes by id alone. Accept a
            // trailing `.eq()` either way and record on the first.
            update: (patch: Record<string, unknown>) => {
              const record = (value: unknown) => {
                h.state.contactUpdateCalls.push({ id: value, patch })
                return {
                  eq: () => Promise.resolve({ data: null, error: null }),
                }
              }
              return { eq: (_col: string, value: unknown) => record(value as string) }
            },
            delete: () => ({
              eq: () => ({
                in: () => Promise.resolve({ data: null, error: null }),
              }),
            }),
            insert: (row: Record<string, unknown>) => {
              h.state.contactInsertCalls.push(row)
              return {
                select: () => ({
                  single: () =>
                    Promise.resolve({
                      data: h.state.contactsInsertResponse?.data ?? {
                        id: 'inserted-1',
                        ...row,
                      },
                      error: null,
                    }),
                }),
              }
            },
          }
        case 'messages':
          return {
            // Two different chains land here, told apart by the count
            // option: the prior-message count (head request) and the
            // reply-context parent lookup.
            select: (_columns: string, options?: { head?: boolean }) =>
              options?.head
                ? // priorCustomerMsgCount: select('id',{count,head}).eq().eq()
                  {
                    eq: () => ({
                      eq: () =>
                        Promise.resolve({
                          count: h.state.priorCustomerMsgCount,
                          error: null,
                        }),
                    }),
                  }
                : // lookupInternalIdByMetaId: select('id').eq().eq().maybeSingle()
                  {
                    eq: () => ({
                      eq: () => ({
                        maybeSingle: () =>
                          Promise.resolve({
                            data: h.state.replyContextParent,
                            error: null,
                          }),
                      }),
                    }),
                  },
            // Idempotent insert: upsert(...).select('id')
            upsert: (row: Record<string, unknown>, options: unknown) => {
              h.state.upsertCalls.push({ row, options })
              return {
                select: () =>
                  Promise.resolve({
                    data: h.state.messageUpsertResult,
                    error: null,
                  }),
              }
            },
            // Background transcription writes the transcript back onto the row.
            update: (patch: Record<string, unknown>) => ({
              eq: (_col: string, value: unknown) => {
                h.state.messageTranscriptUpdates.push({ id: value, patch })
                return Promise.resolve({ data: null, error: null })
              },
            }),
          }
        default:
          throw new Error(`unexpected table: ${table}`)
      }
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: null, error: null })
    },
    // Service-role Storage, used by the inbound-media mirror (#466).
    storage: {
      from(bucket: string) {
        return {
          upload: (
            path: string,
            _body: unknown,
            options: { contentType?: string },
          ) => {
            h.state.storageUploads.push({ bucket, path, options })
            return Promise.resolve({ error: h.state.storageUploadError })
          },
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://cdn.test/${bucket}/${path}` },
          }),
        }
      },
    },
  }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-token',
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
  sendTypingIndicator: vi.fn(),
}))
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(),
  isUniqueViolation: () => false,
}))
vi.mock('@/lib/whatsapp/webhook-signature', () => ({
  verifyMetaWebhookSignature: () => true,
}))
vi.mock('@/lib/whatsapp/template-webhook', () => ({
  isTemplateWebhookField: () => false,
  handleTemplateWebhookChange: vi.fn(),
}))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.runAutomationsForTrigger,
}))
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: h.dispatchInboundToFlows,
}))
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: h.dispatchInboundToAiReply,
}))
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: h.dispatchWebhookEvent,
}))
vi.mock('@/lib/ai/transcribe', () => ({
  transcribeAudio: vi.fn(),
}))
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: vi.fn(),
  engineSendAiReply: vi.fn(),
}))

import { POST } from './route'
import { getMediaUrl, downloadMedia, sendTypingIndicator } from '@/lib/whatsapp/meta-api'
import { transcribeAudio } from '@/lib/ai/transcribe'
import { engineSendText } from '@/lib/flows/meta-send'
import { findExistingContact } from '@/lib/contacts/dedupe'

const mockGetMediaUrl = vi.mocked(getMediaUrl)
const mockDownloadMedia = vi.mocked(downloadMedia)
const mockSendTypingIndicator = vi.mocked(sendTypingIndicator)
const mockTranscribeAudio = vi.mocked(transcribeAudio)
const mockEngineSendText = vi.mocked(engineSendText)
const mockFindExistingContact = vi.mocked(findExistingContact)

const TEXT_MESSAGE = {
  id: 'wamid.TEST1',
  from: '15551230000',
  timestamp: '1700000000',
  type: 'text',
  text: { body: 'hello' },
}

function inboundRequest(message: Record<string, unknown> = TEXT_MESSAGE) {
  const body = {
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'pn-1' },
              contacts: [{ wa_id: '15551230000', profile: { name: 'Ada' } }],
              messages: [message],
            },
          },
        ],
      },
    ],
  }
  return {
    text: async () => JSON.stringify(body),
    headers: { get: () => 'sha256=stub' },
  } as unknown as Request
}

/**
 * Inbound from a sender on a number NOT registered on WhatsApp: Meta sends
 * a BSUID in `contacts[].user_id` and an EMPTY `wa_id`, which is the case
 * that used to create a contact with an undeliverable `phone`.
 */
function bsuidInboundRequest() {
  const body = {
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'pn-1' },
              contacts: [
                {
                  wa_id: '',
                  user_id: 'CO.1008477715690681',
                  profile: { name: 'Ana Ruiz', username: 'anaruiz' },
                },
              ],
              messages: [
                {
                  id: 'wamid.BSUID1',
                  from: '',
                  from_user_id: 'CO.1008477715690681',
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body: 'hola' },
                },
              ],
            },
          },
        ],
      },
    ],
  }
  return {
    text: async () => JSON.stringify(body),
    headers: { get: () => 'sha256=stub' },
  } as unknown as Request
}

async function runWebhook(message?: Record<string, unknown>) {
  const res = await POST(inboundRequest(message))
  // Drain the after() callback exactly as the runtime would.
  for (const cb of h.state.afterCallbacks) await cb()
  return res
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.messageUpsertResult = [{ id: 'msg-1' }]
  h.state.priorCustomerMsgCount = 0
  h.state.replyContextParent = null
  h.state.conversation = { id: 'conv-1', unread_count: 0, account_id: 'acc-1' }
  h.state.upsertCalls = []
  h.state.rpcCalls = []
  h.state.afterCallbacks = []
  h.state.automationStarted = 0
  h.state.automationCompleted = 0
  h.state.mirrorInboundMedia = true
  h.state.storageUploads = []
  h.state.storageUploadError = null
  h.state.existingContactResult = null
  h.state.contactsInsertResponse = null
  h.state.bsuidLookupResponse = null
  h.state.bsuidPhoneContacts = []
  h.state.siblingPhoneCandidates = []
  h.state.emptyPhoneContacts = []
  h.state.contactUpdateCalls = []
  h.state.contactInsertCalls = []
  h.state.messageTranscriptUpdates = []
  h.state.conversationSummaryUpdates = []
  mockGetMediaUrl.mockResolvedValue({
    url: 'https://lookaside.fbsbx.com/whatsapp/abc',
    mimeType: 'image/jpeg',
    fileSize: 2048,
  })
  mockDownloadMedia.mockResolvedValue({
    buffer: Buffer.alloc(2048),
    contentType: 'image/jpeg',
  })
  mockTranscribeAudio.mockResolvedValue(null)
  mockEngineSendText.mockResolvedValue({ whatsapp_message_id: 'wamid.FALLBACK' })
  mockSendTypingIndicator.mockResolvedValue(undefined)
  h.dispatchInboundToFlows.mockResolvedValue({ consumed: false })
  h.dispatchInboundToAiReply.mockResolvedValue(undefined)
  h.dispatchWebhookEvent.mockResolvedValue(undefined)
  mockFindExistingContact.mockResolvedValue({
    id: 'contact-1',
    name: 'Ada',
    phone: '15551230000',
  })
  h.runAutomationsForTrigger.mockImplementation(() => {
    h.state.automationStarted++
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        h.state.automationCompleted++
        resolve()
      }, 0)
    })
  })
})

describe('inbound webhook: idempotent insert (#367)', () => {
  it('a genuine first delivery persists once and fans out downstream', async () => {
    await runWebhook()

    // Inserted via upsert with the (conversation_id, message_id) conflict
    // target — not a bare insert.
    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0].options).toMatchObject({
      onConflict: 'conversation_id,message_id',
      ignoreDuplicates: true,
    })
    // Downstream side effects ran exactly once.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1)
  })

  it('a replayed delivery is a no-op: no unread bump, no fan-out', async () => {
    // Upsert hits the unique index and returns no row.
    h.state.messageUpsertResult = []

    await runWebhook()

    expect(h.state.upsertCalls).toHaveLength(1)
    // None of the downstream side effects fire on a replay.
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled()
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
  })
})

describe('inbound webhook: atomic unread bump (#369)', () => {
  it('increments unread through the DB-side RPC, not a read-modify-write', async () => {
    await runWebhook()

    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.state.rpcCalls[0]).toMatchObject({
      name: 'bump_conversation_on_inbound',
      args: { p_conversation_id: 'conv-1' },
    })
  })
})

describe('inbound webhook: typing indicator', () => {
  it('shows the WhatsApp typing indicator immediately for text inbound', async () => {
    await runWebhook(TEXT_MESSAGE)

    expect(mockSendTypingIndicator).toHaveBeenCalledTimes(1)
    expect(mockSendTypingIndicator).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'plain-token',
      messageId: 'wamid.TEST1',
    })
  })

  it('shows the typing indicator immediately for audio inbound', async () => {
    mockTranscribeAudio.mockResolvedValue('hola')
    const audio = {
      id: 'wamid.AUDIO_TYPING',
      from: '15551230000',
      timestamp: '1700000000',
      type: 'audio',
      audio: { id: 'media-9', mime_type: 'audio/ogg; codecs=opus' },
    }

    await runWebhook(audio)

    expect(mockSendTypingIndicator).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'plain-token',
      messageId: 'wamid.AUDIO_TYPING',
    })
  })

  it('does not show the typing indicator for attachment-only inbound', async () => {
    await runWebhook({
      id: 'wamid.IMG_TYPING',
      from: '15551230000',
      timestamp: '1700000000',
      type: 'image',
      image: { id: 'img-1', mime_type: 'image/jpeg' },
    })

    expect(mockSendTypingIndicator).not.toHaveBeenCalled()
  })

  it('fails silently when Meta rejects the indicator (best-effort)', async () => {
    mockSendTypingIndicator.mockRejectedValueOnce(new Error('Meta API error: 400'))

    await runWebhook(TEXT_MESSAGE)

    // The webhook still processes the message and fans out — the typing
    // indicator must never break inbound processing.
    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
  })
})

describe('inbound webhook: template quick-reply buttons (#478)', () => {
  // A customer tapping a QUICK_REPLY button on a broadcast template.
  // `context.id` points at the template message we sent — which the
  // broadcast path never wrote to `messages`, so the parent lookup
  // legitimately misses and the reply is stored unquoted.
  const templateButtonTap = {
    id: 'wamid.BTN1',
    from: '15551230000',
    timestamp: '1700000000',
    type: 'button',
    button: { text: 'Yes, interested', payload: 'YES_INTERESTED' },
    context: { id: 'wamid.BROADCAST1' },
  }

  it('stores the tap as an interactive reply, not an unsupported message', async () => {
    await runWebhook(templateButtonTap)

    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      content_type: 'interactive',
      content_text: 'Yes, interested',
      interactive_reply_id: 'YES_INTERESTED',
      reply_to_message_id: null,
    })
  })

  it('routes the tap to flows and fires the interactive_reply trigger', async () => {
    await runWebhook(templateButtonTap)

    expect(h.dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          kind: 'interactive_reply',
          reply_id: 'YES_INTERESTED',
          reply_title: 'Yes, interested',
          meta_message_id: 'wamid.BTN1',
        },
      }),
    )
    const triggers = h.runAutomationsForTrigger.mock.calls.map(
      (call) => (call[0] as { triggerType: string }).triggerType,
    )
    expect(triggers).toContain('interactive_reply')
  })

  it('also dispatches the tap to the AI bot when no Flow consumes it', async () => {
    // No Flow is running on this thread, so nothing else answers the
    // customer. The tap must reach the LLM as an ordinary user turn —
    // it used to be skipped outright, which left "Quiero información"
    // pressing into silence.
    await runWebhook(templateButtonTap)

    expect(h.dispatchInboundToAiReply).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        // Keeps WhatsApp's typing indicator alive for the follow-up.
        composeMessageId: 'wamid.BTN1',
      }),
    )
  })

  it('still stands down when a Flow consumed the tap', async () => {
    // Flows win over the LLM — that's the gate that actually protects a
    // menu a Flow owns, and it must keep working now that the separate
    // interactive-tap skip is gone.
    h.dispatchInboundToFlows.mockResolvedValue({ consumed: true })

    await runWebhook(templateButtonTap)

    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
  })

  it('shows the typing indicator while the bot answers a tap', async () => {
    await runWebhook(templateButtonTap)

    expect(mockSendTypingIndicator).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'plain-token',
      messageId: 'wamid.BTN1',
    })
  })

  it('falls back to the label when the template button carries no payload', async () => {
    await runWebhook({
      ...templateButtonTap,
      button: { text: 'Track my order' },
    })

    expect(h.state.upsertCalls[0].row).toMatchObject({
      content_type: 'interactive',
      content_text: 'Track my order',
      interactive_reply_id: 'Track my order',
    })
  })
})

describe('inbound webhook: voice notes', () => {
  // OGG opus from WhatsApp (default voice note envelope).
  const AUDIO_MESSAGE = {
    id: 'wamid.VOICE1',
    from: '15551230000',
    timestamp: '1700000000',
    type: 'audio',
    audio: { id: 'media-1', mime_type: 'audio/ogg; codecs=opus' },
  }

  it('transcribes the note and fans out on the transcript', async () => {
    mockTranscribeAudio.mockResolvedValue(
      'Quiero agendar una cita para el martes',
    )

    await runWebhook(AUDIO_MESSAGE)

    expect(mockTranscribeAudio).toHaveBeenCalledWith(
      expect.any(Buffer),
      'audio/ogg; codecs=opus',
    )
    // Saved immediately (content_text null) — the insert is NOT gated on
    // the transcription, so the inbox realtime event fires at once.
    expect(h.state.upsertCalls[0].row).toMatchObject({
      content_type: 'audio',
      content_text: null,
    })
    // The transcript is then written back onto the row and the
    // conversation-list summary the unread bump stamped as `[audio]`.
    expect(h.state.messageTranscriptUpdates).toEqual([
      {
        id: 'msg-1',
        patch: { content_text: 'Quiero agendar una cita para el martes' },
      },
    ])
    expect(h.state.conversationSummaryUpdates).toEqual([
      {
        id: 'conv-1',
        patch: { last_message_text: 'Quiero agendar una cita para el martes' },
      },
    ])
    // Downstream fan-out runs on the transcript, as if it were text.
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    expect(h.dispatchInboundToAiReply).toHaveBeenCalledTimes(1)
    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1)
    expect(mockEngineSendText).not.toHaveBeenCalled()
  })

  it('sends a friendly fallback when transcription fails', async () => {
    mockTranscribeAudio.mockResolvedValue(null)

    await runWebhook(AUDIO_MESSAGE)

    // The note is still persisted for the record — with null_ content
    // text, immediately (not after transcription).
    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      content_type: 'audio',
      content_text: null,
      media_type: 'audio/ogg; codecs=opus',
    })
    // Nothing is written back since there is no transcript.
    expect(h.state.messageTranscriptUpdates).toHaveLength(0)
    expect(h.state.conversationSummaryUpdates).toHaveLength(0)
    // Friendly ask-it-in-text reply goes out.
    expect(mockEngineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('nota de voz'),
        contactId: 'contact-1',
        conversationId: 'conv-1',
      }),
    )
    // With nothing to act on, flows / automations / AI stay out.
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled()
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
    // message.received still fires so external listeners know it arrived.
    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1)
  })

  it('treats a non-Meta "voice" envelope like an audio note', async () => {
    // YCloud and other gateways deliver voice notes under `type: "voice"`
    // with the envelope in `voice` rather than Meta's `audio`.
    mockTranscribeAudio.mockResolvedValue('Quiero agendar una cita')
    const VOICE_MESSAGE = {
      id: 'wamid.VOICE2',
      from: '15551230000',
      timestamp: '1700000000',
      type: 'voice',
      voice: { id: 'media-2', mime_type: 'audio/ogg; codecs=opus' },
    }

    await runWebhook(VOICE_MESSAGE)

    // Same pipeline as audio: fetch → download → mirror → transcribe.
    expect(mockTranscribeAudio).toHaveBeenCalledWith(
      expect.any(Buffer),
      'audio/ogg; codecs=opus',
    )
    expect(h.state.storageUploads).toHaveLength(1)
    // Inserted immediately with content_text null; transcript written
    // back in the background.
    expect(h.state.upsertCalls[0].row).toMatchObject({
      content_type: 'audio',
      content_text: null,
      media_type: 'audio/ogg; codecs=opus',
    })
    expect(h.state.messageTranscriptUpdates).toEqual([
      { id: 'msg-1', patch: { content_text: 'Quiero agendar una cita' } },
    ])
    // Fans out on the transcript exactly like an audio note.
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    expect(h.dispatchInboundToAiReply).toHaveBeenCalledTimes(1)
    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1)
    expect(mockEngineSendText).not.toHaveBeenCalled()
  })
})

describe('inbound webhook: inbound media is mirrored (#466)', () => {
  const IMAGE_MESSAGE = {
    id: 'wamid.IMG1',
    from: '15551230000',
    timestamp: '1700000000',
    type: 'image',
    image: { id: '1234567890123456', mime_type: 'image/jpeg', caption: 'hi' },
  }

  it('stores a durable bucket URL instead of the expiring proxy path', async () => {
    await runWebhook(IMAGE_MESSAGE)

    expect(h.state.storageUploads).toHaveLength(1)
    expect(h.state.storageUploads[0].bucket).toBe('chat-media')
    expect(h.state.storageUploads[0].path).toBe(
      'account-acc-1/inbound/1234567890123456-image-1700000000.jpg',
    )
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url:
        'https://cdn.test/chat-media/account-acc-1/inbound/1234567890123456-image-1700000000.jpg',
      // Meta's MIME type used to be discarded outright (`void mediaType`).
      media_type: 'image/jpeg',
    })
  })

  it('falls back to the proxy URL when the upload is refused', async () => {
    h.state.storageUploadError = { message: 'mime type not supported' }

    await runWebhook(IMAGE_MESSAGE)

    // The message still lands, and it still lands with a usable URL —
    // the mirror failing must never cost us the message.
    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/1234567890123456',
      media_type: 'image/jpeg',
    })
  })

  it('falls back to the proxy URL when the download from Meta throws', async () => {
    mockDownloadMedia.mockRejectedValueOnce(new Error('Media download failed: 404'))

    await runWebhook(IMAGE_MESSAGE)

    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/1234567890123456',
    })
  })

  it('skips media larger than the bucket accepts, without downloading it', async () => {
    mockGetMediaUrl.mockResolvedValue({
      url: 'https://lookaside.fbsbx.com/whatsapp/big',
      mimeType: 'application/pdf',
      fileSize: 40 * 1024 * 1024,
    })

    await runWebhook({
      id: 'wamid.DOC1',
      from: '15551230000',
      timestamp: '1700000000',
      type: 'document',
      document: {
        id: '999',
        mime_type: 'application/pdf',
        filename: 'huge.pdf',
      },
    })

    expect(mockDownloadMedia).not.toHaveBeenCalled()
    expect(h.state.storageUploads).toHaveLength(0)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/999',
      media_type: 'application/pdf',
    })
  })

  it("names the object after a document's own filename", async () => {
    mockGetMediaUrl.mockResolvedValue({
      url: 'https://lookaside.fbsbx.com/whatsapp/doc',
      mimeType: 'application/pdf',
      fileSize: 4096,
    })
    mockDownloadMedia.mockResolvedValue({
      buffer: Buffer.alloc(4096),
      contentType: 'application/pdf',
    })

    await runWebhook({
      id: 'wamid.DOC2',
      from: '15551230000',
      timestamp: '1700000000',
      type: 'document',
      document: {
        id: '1234567890123456',
        mime_type: 'application/pdf',
        filename: 'invoice.pdf',
        caption: 'have a look',
      },
    })

    expect(h.state.storageUploads[0].path).toBe(
      'account-acc-1/inbound/1234567890123456-invoice.pdf',
    )
  })

  it('does not mirror when the account has opted out', async () => {
    h.state.mirrorInboundMedia = false

    await runWebhook(IMAGE_MESSAGE)

    expect(mockDownloadMedia).not.toHaveBeenCalled()
    expect(h.state.storageUploads).toHaveLength(0)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/1234567890123456',
      // Still recorded — the MIME type costs nothing and makes the
      // download name right even for proxied media.
      media_type: 'image/jpeg',
    })
  })

  it('mirrors when the column is absent, e.g. a row read before migration 039', async () => {
    h.state.mirrorInboundMedia = undefined

    await runWebhook(IMAGE_MESSAGE)

    expect(h.state.storageUploads).toHaveLength(1)
  })

  it('leaves text messages alone', async () => {
    await runWebhook()

    expect(mockGetMediaUrl).not.toHaveBeenCalled()
    expect(h.state.storageUploads).toHaveLength(0)
    expect(h.state.upsertCalls[0].row).toMatchObject({ media_type: null })
  })
})

describe('inbound webhook: after() awaits automations (#368)', () => {
  it('every triggered automation settles before the after() callback resolves', async () => {
    await runWebhook()

    // first_inbound_message + new_message_received + keyword_match.
    expect(h.state.automationStarted).toBe(3)
    // If the dispatches were fire-and-forget, completed would still be 0
    // here — the callback would have resolved before the timers fired.
    expect(h.state.automationCompleted).toBe(3)
  })
})

describe('inbound webhook: contact auto-creation / backfill', () => {
  it('creates a new contact with the WhatsApp profile name and number', async () => {
    mockFindExistingContact.mockResolvedValue(null)

    await runWebhook()

    const insert = h.state.contactInsertCalls[0]
    expect(insert).toMatchObject({
      account_id: 'acc-1',
      user_id: 'user-1',
      phone: '15551230000',
      name: 'Ada',
    })
  })

  it('updates an existing contact that is missing a name', async () => {
    // Phone already matches the sender exactly; only name is backfilled.
    mockFindExistingContact.mockResolvedValue({
      id: 'contact-1',
      name: null,
      phone: '15551230000',
    })

    await runWebhook()

    expect(h.state.contactUpdateCalls).toHaveLength(1)
    expect(h.state.contactUpdateCalls[0].id).toBe('contact-1')
    expect(h.state.contactUpdateCalls[0].patch).toMatchObject({
      name: 'Ada',
      updated_at: expect.any(String),
    })
    // The phone didn't change — it already equals the sender number.
    expect(h.state.contactUpdateCalls[0].patch).not.toHaveProperty('phone')
  })

  it('promotes a fuzzy phone match to the exact sender number', async () => {
    // Stored with a country trunk prefix (00) that differs from the
    // exact digits Meta delivers — the row still resolves via the
    // last-8-digit fuzzy match, then gets rewritten to the sender number.
    mockFindExistingContact.mockResolvedValue({
      id: 'contact-1',
      name: 'Ada',
      phone: '0015551230000',
    })

    await runWebhook()

    expect(h.state.contactUpdateCalls).toHaveLength(1)
    expect(h.state.contactUpdateCalls[0].patch).toMatchObject({
      phone: '15551230000',
      updated_at: expect.any(String),
    })
  })

  it('does not adopt a number-less row matched only by profile name', async () => {
    // Display names are not identities: an inbound carrying a real phone
    // gets its own contact even when another phone-less row shares the name.
    mockFindExistingContact.mockResolvedValue(null)

    await runWebhook()

    expect(h.state.contactInsertCalls).toHaveLength(1)
    expect(h.state.contactInsertCalls[0]).toMatchObject({
      phone: '15551230000',
      name: 'Ada',
    })
  })

  it('stores the numeric BSUID in phone and keeps the handle @-prefixed', async () => {
    // Senders on numbers NOT registered on WhatsApp arrive with a
    // namespaced BSUID ('CO.…') instead of `wa_id`. The contact keeps an
    // EMPTY `phone` — never the Meta id — and the BSUID lives only in
    // `wa_user_id`.
    mockFindExistingContact.mockResolvedValue(null)

    await POST(bsuidInboundRequest())
    for (const cb of h.state.afterCallbacks) await cb()

    expect(h.state.contactInsertCalls).toHaveLength(1)
    expect(h.state.contactInsertCalls[0]).toMatchObject({
      // No dialable number disclosed: the @handle becomes the destination,
      // `phone` is never blank, and the BSUID lives in wa_user_id.
      phone: 'unknown',
      wa_user_id: '1008477715690681',
      // Username keeps the '@' so it renders as WhatsApp shows it.
      username: '@anaruiz',
    })
    // The BSUID must never be stored as the username.
    expect(h.state.contactInsertCalls[0].username).not.toMatch(/^@?CO\./)
  })

  it('repairs a bare 16-digit BSUID sitting in phone', async () => {
    // The prefix-stripped shape the task calls out: `phone` holds
    // '1008477715690681' with no 'CO.' marker at all, so a
    // `like 'CO.%'`-only repair would miss it entirely.
    mockFindExistingContact.mockResolvedValue(null)
    h.state.bsuidPhoneContacts = [
      {
        id: 'contact-bare',
        account_id: 'acc-1',
        phone: '1008477715690681',
        name: 'Ana Ruiz',
        username: '@anaruiz',
      },
    ]
    h.state.siblingPhoneCandidates = [{ phone: '573122182949' }]

    await runWebhook()

    const patch = h.state.contactUpdateCalls[0]?.patch
    expect(patch).toBeDefined()
    // Moved into wa_user_id…
    expect(patch.wa_user_id).toBe('1008477715690681')
    // …and phone restored to the real number from the sibling row.
    expect(patch.phone).toBe('573122182949')
  })

  it('adds the @ prefix to a bare handle during repair', async () => {
    mockFindExistingContact.mockResolvedValue(null)
    h.state.bsuidPhoneContacts = [
      {
        id: 'contact-noat',
        account_id: 'acc-1',
        phone: '1008477715690681',
        name: 'Ana Ruiz',
        username: 'anaruiz',
      },
    ]

    await runWebhook()

    const patch = h.state.contactUpdateCalls[0]?.patch ?? {}
    expect(patch.username).toBe('@anaruiz')
    expect(patch.wa_user_id).toBe('1008477715690681')
  })

  it('leaves a legitimately long E.164 phone alone during repair', async () => {
    // The 15-digit LIKE is deliberately over-broad. isBsuidLike must
    // filter it out so a real (if unusually long) number is never
    // relocated into wa_user_id.
    mockFindExistingContact.mockResolvedValue(null)
    h.state.bsuidPhoneContacts = [
      {
        id: 'contact-real',
        account_id: 'acc-1',
        phone: '573122182949',
        name: 'Real Person',
      },
    ]

    await runWebhook()

    const patches = h.state.contactUpdateCalls.map((c) => c.patch)
    expect(
      patches.some((p) => p.wa_user_id && !String(p.wa_user_id).includes('573122182949')),
    ).toBe(false)
  })

  it('gives a BSUID-only sender its own contact and never touches a same-named row', async () => {
    // 'Ana Ruiz' already has a real number saved on one row, but a
    // BSUID that is not stored anywhere belongs to nobody yet. Sharing a
    // display name is not identity: the sender gets a new contact and the
    // real number is left untouched.
    mockFindExistingContact.mockResolvedValue(null)
    h.state.bsuidLookupResponse = {
      id: 'contact-real-phone',
      account_id: 'acc-1',
      phone: '573122182949',
      name: 'Ana Ruiz',
      username: '@anaruiz',
    }

    await POST(bsuidInboundRequest())
    for (const cb of h.state.afterCallbacks) await cb()

    expect(h.state.contactInsertCalls).toHaveLength(1)
    expect(h.state.contactInsertCalls[0]).toMatchObject({
      phone: 'unknown',
      wa_user_id: '1008477715690681',
    })
    expect(
      h.state.contactUpdateCalls.filter((c) => c.patch.phone),
    ).toHaveLength(0)
  })

  it('does not steal a contact already bound to a different BSUID', async () => {
    // Two different people can share a display name. A row already carrying
    // another BSUID must never be adopted by a same-name match.
    mockFindExistingContact.mockResolvedValue(null)
    h.state.bsuidLookupResponse = {
      id: 'contact-other-person',
      account_id: 'acc-1',
      phone: '573000000000',
      name: 'Ana Ruiz',
      wa_user_id: '999999999999999',
    }

    await POST(bsuidInboundRequest())
    for (const cb of h.state.afterCallbacks) await cb()

    // Falls through to a fresh insert rather than merging the two people.
    expect(h.state.contactInsertCalls).toHaveLength(1)
  })

  it('never stores a BSUID as the username', async () => {
    // A payload with no usable handle must not end up writing '@CO.…'.
    mockFindExistingContact.mockResolvedValue(null)

    const body = {
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'pn-1' },
                contacts: [
                  { wa_id: '', user_id: 'CO.999', profile: { name: 'Ana' } },
                ],
                messages: [
                  {
                    id: 'wamid.BSUID2',
                    from: '',
                    from_user_id: 'CO.999',
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'hola' },
                  },
                ],
              },
            },
          ],
        },
      ],
    }

    await POST({
      text: async () => JSON.stringify(body),
      headers: { get: () => 'sha256=stub' },
    } as unknown as Request)
    for (const cb of h.state.afterCallbacks) await cb()

    const row = h.state.contactInsertCalls[0]
    expect(row.username).toBeUndefined()
    expect(row.phone).toBe('unknown')
    expect(row.wa_user_id).toBe('999')
  })

  it('reuses the contact matched by BSUID instead of inserting a duplicate', async () => {
    // The same person first reached us as a bare BSUID and now writes from
    // a registered number. Matching on phone alone would create a second
    // contact row for them.
    mockFindExistingContact.mockResolvedValue(null)
    h.state.bsuidLookupResponse = {
      id: 'contact-existing',
      account_id: 'acc-1',
      user_id: 'user-1',
      phone: '573122182949',
      name: 'Ana Ruiz',
      username: '@anaruiz',
      wa_user_id: '1008477715690681',
    }

    await POST(bsuidInboundRequest())
    for (const cb of h.state.afterCallbacks) await cb()

    expect(h.state.contactInsertCalls).toHaveLength(0)
  })

  it('repairs a contact whose phone holds a CO.-prefixed BSUID', async () => {
    // Rows written by the pre-fix handler. repairBsuidPhoneContacts() moves
    // the identifier into wa_user_id and normalizes the handle so the
    // dedupe pre-filter can finally match the real number.
    mockFindExistingContact.mockResolvedValue(null)
    h.state.bsuidPhoneContacts = [
      {
        id: 'contact-broken',
        account_id: 'acc-1',
        phone: 'CO.1008477715690681',
        name: 'Ana Ruiz',
        username: 'anaruiz',
      },
    ]

    await runWebhook()

    expect(h.state.contactUpdateCalls.length).toBeGreaterThan(0)
    const patch = h.state.contactUpdateCalls[0].patch
    expect(patch.wa_user_id).toBe('1008477715690681')
    expect(patch.username).toBe('@anaruiz')
    // No sibling had a real number, so `phone` must NOT be overwritten with
    // a fabricated one — the row is left for a later inbound to repair.
    expect(patch.phone).toBeUndefined()
  })

  it('adopts a sibling contact number when repairing a CO.-prefixed phone', async () => {
    // 'Ana Ruiz' has two rows: the good one with his real number,
    // and the broken one holding the BSUID. The repair should adopt the
    // real number from the sibling rather than inventing one.
    mockFindExistingContact.mockResolvedValue(null)
    h.state.bsuidPhoneContacts = [
      {
        id: 'contact-broken',
        account_id: 'acc-1',
        phone: 'CO.1008477715690681',
        name: 'Ana Ruiz',
        username: 'anaruiz',
      },
    ]
    h.state.siblingPhoneCandidates = [{ phone: '573122182949' }]

    await runWebhook()

    expect(h.state.contactUpdateCalls.length).toBeGreaterThan(0)
    expect(h.state.contactUpdateCalls[0].patch).toMatchObject({
      phone: '573122182949',
      wa_user_id: '1008477715690681',
      username: '@anaruiz',
    })
  })
})
