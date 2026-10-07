import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendMessageToConversation,
  SendMessageError,
  type SendMessageParams,
} from './send-message';
import { InvalidRecipientError, MetaApiError } from './meta-api';

// A db that explodes if touched — these tests cover the param
// validation that MUST short-circuit before any query runs.
function noDb(): SupabaseClient {
  return {
    from() {
      throw new Error('db should not be queried for invalid params');
    },
  } as unknown as SupabaseClient;
}

async function expectSendError(
  params: SendMessageParams,
  status: number,
  messageMatch?: RegExp
) {
  await expect(
    sendMessageToConversation(noDb(), 'acct-1', params)
  ).rejects.toBeInstanceOf(SendMessageError);
  await sendMessageToConversation(noDb(), 'acct-1', params).catch(
    (e: SendMessageError) => {
      expect(e.status).toBe(status);
      if (messageMatch) expect(e.message).toMatch(messageMatch);
    }
  );
}

describe('sendMessageToConversation — param validation (pre-DB)', () => {
  const base = { conversationId: 'cv-1' };

  it('requires conversation_id and message_type', async () => {
    await expectSendError({ conversationId: '', messageType: 'text' }, 400);
    await expectSendError({ conversationId: 'cv-1', messageType: '' }, 400);
  });

  it('rejects an unsupported message_type', async () => {
    await expectSendError(
      { ...base, messageType: 'carrier-pigeon' },
      400,
      /Unsupported message_type/
    );
  });

  it('requires content_text for text messages', async () => {
    await expectSendError(
      { ...base, messageType: 'text' },
      400,
      /content_text is required/
    );
  });

  it('requires template_name for template messages', async () => {
    await expectSendError(
      { ...base, messageType: 'template' },
      400,
      /template_name is required/
    );
  });

  it('requires media_url for media kinds', async () => {
    for (const kind of ['image', 'video', 'document', 'audio']) {
      await expectSendError(
        { ...base, messageType: kind },
        400,
        /media_url is required/
      );
    }
  });

  it('rejects an over-long media caption (non-audio)', async () => {
    await expectSendError(
      {
        ...base,
        messageType: 'image',
        mediaUrl: 'https://x/y.jpg',
        contentText: 'a'.repeat(1025),
      },
      400,
      /1024-character limit/
    );
  });

  it('requires a valid interactive payload for interactive messages', async () => {
    // Missing payload entirely.
    await expectSendError(
      { ...base, messageType: 'interactive' },
      400,
      /payload is required/
    );
    // Too many buttons.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [
            { id: 'a', title: 'A' },
            { id: 'b', title: 'B' },
            { id: 'c', title: 'C' },
            { id: 'd', title: 'D' },
          ],
        },
      },
      400,
      /at most 3 buttons/
    );
    // Over-long button title.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [{ id: 'a', title: 'x'.repeat(21) }],
        },
      },
      400,
      /20-character limit/
    );
  });

  it('allows a long "caption" on audio (audio carries none) — so it reaches the DB', async () => {
    // Audio is exempt from the caption cap, so validation passes and we
    // proceed to the conversation lookup — proven by the stub throwing.
    const spy = vi.fn(() => {
      throw new Error('reached DB');
    });
    const db = { from: spy } as unknown as SupabaseClient;
    await expect(
      sendMessageToConversation(db, 'acct-1', {
        ...base,
        messageType: 'audio',
        mediaUrl: 'https://x/y.ogg',
        contentText: 'a'.repeat(2000),
      })
    ).rejects.toThrow('reached DB');
    expect(spy).toHaveBeenCalledWith('conversations');
  });
});

describe('SendMessageError', () => {
  it('carries a machine code and an HTTP status', () => {
    const e = new SendMessageError('meta_error', 'boom', 502);
    expect(e.code).toBe('meta_error');
    expect(e.status).toBe(502);
    expect(e).toBeInstanceOf(Error);
  });
});

// ============================================================
// Full send path — what actually lands in `messages` (issue #483).
// ============================================================

const sendTemplateMessage = vi.fn(async () => ({ messageId: 'wamid.1' }));
// Referenced lazily from the mock factory below (same pattern as
// sendTemplateMessage) so a test can swap in a rejecting implementation
// without the factory reading it during hoisting.
const sendMediaMessageMock = vi.fn(async () => ({ messageId: 'wamid.media' }));
const armResponseWaitIfIdle = vi.fn(async () => ({
  scheduled: true,
  reason: 'armed',
  id: 'wait-auto',
  expires_at: '2026-10-06T12:10:00.000Z',
}));

// Timer 2 auto-arm is best-effort: mock it so its DB write never runs in
// these tests, and assert WHEN it is (not) called.
vi.mock('@/lib/whatsapp/response-wait', () => ({
  armResponseWaitIfIdle: (...args: unknown[]) =>
    (armResponseWaitIfIdle as (...a: unknown[]) => unknown)(...args),
}));

// Stub only the senders — the module also exports INTERACTIVE_LIMITS,
// which `interactive.ts` needs for the payload validation covered above.
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.text' })),
  sendTemplateMessage: (...args: unknown[]) =>
    (sendTemplateMessage as unknown as (...a: unknown[]) => unknown)(...args),
  sendMediaMessage: (...args: unknown[]) =>
    (sendMediaMessageMock as unknown as (...a: unknown[]) => unknown)(...args),
  sendInteractiveButtons: vi.fn(async () => ({ messageId: 'wamid.btn' })),
  sendInteractiveList: vi.fn(async () => ({ messageId: 'wamid.list' })),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));

vi.mock('@/lib/flows/admin-client', () => ({
  // Only used for the best-effort "pause active flow run" write.
  supabaseAdmin: () => ({
    from: () => ({
      update: () => ({
        eq: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      }),
    }),
  }),
}));

interface CapturedWrites {
  message?: Record<string, unknown>;
  conversation?: Record<string, unknown>;
}

/**
 * Supabase fake covering the tables the send path touches. Each table
 * gets a builder that is both chainable and awaitable, so the same
 * object serves `.single()` lookups and the bare `select().eq().eq()`
 * the template resolver uses.
 */
function sendPathDb(
  templateRows: unknown[],
  captured: CapturedWrites,
  opts?: {
    contact?: Record<string, unknown>;
    inboundRows?: unknown[];
    /** Row returned when the send resolves an explicit `reply_to_message_id`. */
    replyParent?: { message_id?: string | null };
  }
): SupabaseClient {
  const conversation = {
    id: 'cv-1',
    contact: opts?.contact ?? { id: 'ct-1', phone: '+15551234567' },
  };
  const config = {
    id: 'cfg-1',
    phone_number_id: 'pn-1',
    access_token: 'token',
  };
  // Inbound rows returned by the anchor lookup. `latestInboundAnchorId` reads
  // the newest customer wamid so a send to an opaque-id contact can be quoted.
  const inboundRows = opts?.inboundRows ?? [];

  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        not: () => builder,
        order: () => builder,
        limit: async () => ({
          data: table === 'messages' ? inboundRows : [],
          error: null,
        }),
        insert: (row: Record<string, unknown>) => {
          if (table === 'messages') captured.message = row;
          return builder;
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'conversations') captured.conversation = row;
          return builder;
        },
        maybeSingle: async () => ({
          data: table === 'messages' ? (opts?.replyParent ?? null) : null,
          error: null,
        }),
        single: async () => {
          if (table === 'conversations') {
            return { data: conversation, error: null };
          }
          if (table === 'whatsapp_config') return { data: config, error: null };
          if (table === 'messages') {
            return { data: { id: 'msg-1' }, error: null };
          }
          return { data: null, error: null };
        },
        // Bare-await result — only message_templates is read this way.
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) =>
          resolve({
            data: table === 'message_templates' ? templateRows : [],
            error: null,
          }),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const TEMPLATE_ROW = {
  id: 'tpl-1',
  user_id: 'u-1',
  name: 'order_update',
  category: 'Utility',
  language: 'en',
  body_text: 'Your order {{1}} ships on {{2}}',
  created_at: '2026-01-01T00:00:00Z',
};

describe('sendMessageToConversation — template persistence (#483)', () => {
  it('stores the substituted body when the caller sends no text', async () => {
    const captured: CapturedWrites = {};
    const result = await sendMessageToConversation(
      sendPathDb([TEMPLATE_ROW], captured),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'order_update',
        templateParams: ['A123', 'Friday'],
      }
    );

    expect(result.whatsappMessageId).toBe('wamid.1');
    // Was NULL before the fix — the Inbox rendered an empty bubble.
    expect(captured.message?.content_text).toBe(
      'Your order A123 ships on Friday'
    );
    expect(captured.message?.template_name).toBe('order_update');
    // …and the conversation-list preview reads the body, not '[template]'.
    expect(captured.conversation?.last_message_text).toBe(
      'Your order A123 ships on Friday'
    );
  });

  it('reads body values out of the structured params shape too', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([TEMPLATE_ROW], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'order_update',
      templateMessageParams: { body: ['B456', 'Monday'] },
    });
    expect(captured.message?.content_text).toBe(
      'Your order B456 ships on Monday'
    );
  });

  it("does not override the composer's pre-rendered text", async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([TEMPLATE_ROW], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'order_update',
      templateParams: ['A123', 'Friday'],
      contentText: 'rendered by the composer',
    });
    expect(captured.message?.content_text).toBe('rendered by the composer');
  });

  it("sends the local row's language when the caller names none", async () => {
    sendTemplateMessage.mockClear();
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([TEMPLATE_ROW], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'order_update',
      templateParams: ['A123', 'Friday'],
    });
    // Previously pinned to 'en_US', which matched no row and made Meta
    // reject the send as a missing translation.
    expect(
      (sendTemplateMessage.mock.calls[0] as unknown as [{ language: string }])[0]
        .language
    ).toBe('en');
  });

  it('leaves content_text null when the account has no local template row', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'never_synced',
      templateParams: ['A123'],
    });
    // Nothing to render from — the bubble falls back to the template
    // name rather than inventing a body.
    expect(captured.message?.content_text).toBeNull();
    expect(captured.conversation?.last_message_text).toBe('[template]');
  });
});

// ============================================================
// INBOX <-> AI parity for opaque-id recipients.
//
// WhatsApp will not accept a BSUID / `@user` / `WAID.` id in `to`. It only
// accepts such a message as a QUOTE of one of that person's own messages. The
// AI path always passed the inbound wamid along as that quote, so the bot could
// answer these contacts; the manual INBOX path only did it when the operator
// explicitly hit "Reply", so the same person was undeliverable by hand. These
// tests pin the manual path to the AI's behaviour.
// ============================================================
describe('sendMessageToConversation - opaque-id recipients (INBOX/AI parity)', () => {
  const OPAQUE_CONTACT = {
    id: 'ct-1',
    phone: 'CO.1008477715690681',
    wa_user_id: '1008477715690681',
    username: null,
  };

  function textSend() {
    return sendMessageToConversation(
      sendPathDb([], {}, {
        contact: OPAQUE_CONTACT,
        inboundRows: [{ message_id: 'wamid.INBOUND' }],
      }),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'text',
        contentText: 'Hola, te escribo por aqui',
      }
    );
  }

  it('anchors the send to the newest inbound wamid when the id is opaque', async () => {
    await textSend();

    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ contextMessageId: 'wamid.INBOUND' })
    );
  });

  it('addresses the opaque id directly, as the AI path does', async () => {
    await textSend();

    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: '1008477715690681' })
    );
  });

  it('leaves an ordinary dialable number completely untouched', async () => {
    // Regression guard: the anchor is only ever added for opaque addresses. A
    // customer with a real number must keep being addressed directly, with no
    // quote, exactly as before.
    await sendMessageToConversation(
      sendPathDb([], {}, {
        contact: { id: 'ct-1', phone: '+15551234567' },
        inboundRows: [{ message_id: 'wamid.INBOUND' }],
      }),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'text',
        contentText: 'Hola',
      }
    );

    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: '15551234567' })
    );
    const call = vi.mocked(sendTextMessage).mock.calls[0][0];
    expect(call.contextMessageId).toBeUndefined();
  });

  it('still sends when the thread has no inbound wamid to quote', async () => {
    // No anchor available: attempt the direct address anyway rather than
    // failing the operator's send outright.
    await sendMessageToConversation(
      sendPathDb([], {}, { contact: OPAQUE_CONTACT, inboundRows: [] }),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'text',
        contentText: 'Hola',
      }
    );

    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: '1008477715690681' })
    );
    expect(vi.mocked(sendTextMessage).mock.calls[0][0].contextMessageId).toBeUndefined();
  });

  it('keeps an explicit operator reply target over the thread anchor', async () => {
    await sendMessageToConversation(
      sendPathDb([], {}, {
        contact: OPAQUE_CONTACT,
        inboundRows: [{ message_id: 'wamid.NEWEST' }],
        replyParent: { message_id: 'wamid.CHOSEN' },
      }),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'text',
        contentText: 'Hola',
        replyToMessageId: 'msg-1',
      }
    );

    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    // The bubble the operator actually clicked wins over the newest inbound.
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ contextMessageId: 'wamid.CHOSEN' })
    );
  });
});

// ============================================================
// MEDIA parity — attachments run through the same resolver and the
// same inbound-wamid anchor as text, so an image to a `@user` contact
// is addressed identically to a message the operator types by hand.
// ============================================================
describe('sendMessageToConversation - media recipients (same resolver as text)', () => {
  const OPAQUE_CONTACT = {
    id: 'ct-1',
    phone: 'CO.1008477715690681',
    wa_user_id: '1008477715690681',
    username: null,
  };

  it('addresses a BSUID-only (@user) contact in `to`, anchored like text', async () => {
    await sendMessageToConversation(
      sendPathDb([], {}, {
        contact: OPAQUE_CONTACT,
        inboundRows: [{ message_id: 'wamid.INBOUND' }],
      }),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'image',
        mediaUrl: 'https://cdn.example.com/pic.jpg',
        contentText: 'caption',
      }
    );

    expect(sendMediaMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '1008477715690681',
        kind: 'image',
        link: 'https://cdn.example.com/pic.jpg',
        caption: 'caption',
        contextMessageId: 'wamid.INBOUND',
      })
    );
  });

  it('leaves a dialable number untouched and adds no anchor for media', async () => {
    await sendMessageToConversation(
      sendPathDb([], {}, {
        contact: { id: 'ct-1', phone: '+15551234567' },
        inboundRows: [{ message_id: 'wamid.INBOUND' }],
      }),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'document',
        mediaUrl: 'https://cdn.example.com/doc.pdf',
        filename: 'doc.pdf',
      }
    );

    const call = (
      sendMediaMessageMock.mock.calls[0] as unknown as [
        { to?: string; contextMessageId?: string },
      ]
    )[0];
    expect(call.to).toBe('15551234567');
    expect(call.contextMessageId).toBeUndefined();
  });
});

// ============================================================
// Failure mapping — a recipient problem must never surface as a 502
// that reads like a Meta outage. 422 carries the typed cause; 502
// stays reserved for Meta actually failing upstream.
// ============================================================
describe('sendMessageToConversation - Meta failure mapping', () => {
  const restoreMediaSend = () =>
    sendMediaMessageMock.mockImplementation(async () => ({
      messageId: 'wamid.media',
    }));

  async function captureSendError(error: unknown): Promise<SendMessageError> {
    sendMediaMessageMock.mockImplementation(async () => {
      throw error;
    });
    try {
      await sendMessageToConversation(sendPathDb([], {}, {}), 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'image',
        mediaUrl: 'https://cdn.example.com/pic.jpg',
      });
    } catch (err) {
      return err as SendMessageError;
    } finally {
      restoreMediaSend();
    }
    throw new Error('expected the media send to fail');
  }

  it('maps an unresolvable recipient to 422 invalid_recipient', async () => {
    const err = await captureSendError(
      new InvalidRecipientError('', 'no destination is available for this contact')
    );
    expect(err).toBeInstanceOf(SendMessageError);
    expect(err.status).toBe(422);
    expect(err.code).toBe('invalid_recipient');
    expect(err.message).toMatch(/no destination is available/);
  });

  it("maps Meta's recipient rejection to 422 invalid_recipient", async () => {
    const err = await captureSendError(
      new MetaApiError('Recipient phone number not in allowed list', {
        status: 400,
        code: 131009,
      })
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe('invalid_recipient');
    expect(err.message).toMatch(/not in allowed list/);
  });

  it('maps any other Meta 4xx to 422 with the verbatim cause', async () => {
    const err = await captureSendError(
      new MetaApiError('(#100) Invalid parameter: Invalid file', {
        status: 400,
        code: 100,
      })
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe('meta_rejected');
    expect(err.message).toMatch(/Invalid file/);
  });

  it('keeps 502 for a genuine Meta outage (5xx / network)', async () => {
    const err = await captureSendError(
      new MetaApiError('Service unavailable', { status: 503 })
    );
    expect(err.status).toBe(502);
    expect(err.code).toBe('meta_error');
    expect(err.message).toMatch(/Service unavailable/);
  });
});

describe('sendMessageToConversation — Timer 2 auto-arm on send', () => {
  beforeEach(() => {
    armResponseWaitIfIdle.mockClear();
  });

  it('starts the response-wait countdown for a HUMAN outbound message', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: '¿Estás ahí?',
    });

    expect(armResponseWaitIfIdle).toHaveBeenCalledTimes(1);
    expect(armResponseWaitIfIdle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: 'cv-1',
        contactId: 'ct-1',
        accountId: 'acct-1',
      })
    );
  });

  it('auto-arms for BOT outbounds too (en cuanto el bot responde, vuelve a vigilar)', async () => {
    // The AI/bot answering the client hands the "Esperar respuesta" timer
    // a fresh start — after the inbound cancelled it, the bot's reply is
    // the new "we sent a message and are waiting" moment.
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'nudge',
      senderType: 'bot',
      aiGenerated: true,
    });

    expect(armResponseWaitIfIdle).toHaveBeenCalledTimes(1);
    expect(armResponseWaitIfIdle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: 'cv-1',
        contactId: 'ct-1',
        accountId: 'acct-1',
      })
    );
  });

  it('honors autoArm:false (the Timer 2 runner re-arms itself)', async () => {
    // The expiry-nudge dispatch opts out so its explicit in-place re-arm
    // can never stack a second ACTIVE row for the same conversation.
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'nudge',
      senderType: 'bot',
      aiGenerated: true,
      autoArm: false,
    });

    expect(armResponseWaitIfIdle).not.toHaveBeenCalled();
  });

  it("never fails the send when the auto-arm DB write throws", async () => {
    armResponseWaitIfIdle.mockRejectedValueOnce(new Error('db hiccup'));
    const captured: CapturedWrites = {};
    const result = await sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'hola',
    });

    expect(result.whatsappMessageId).toBe('wamid.text');
  });
});