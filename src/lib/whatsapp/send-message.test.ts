import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendMessageToConversation,
  SendMessageError,
  type SendMessageParams,
} from './send-message';
import { InvalidRecipientError, MetaApiError } from './meta-api';
import { HOW_TO_FIX_DESTINATION } from './recipient-cascade';

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

const adminRead = vi.hoisted(() => ({
  inboundRows: [] as unknown[],
  contactRow: null as Record<string, unknown> | null,
  conversationRow: null as Record<string, unknown> | null,
  persistedPhones: [] as string[],
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'conversations') {
        // The destination cascade re-reads the conversation row (S3/S4) with
        // the service role so RLS can never hide the wamid it resolved to.
        const read = () => ({
          select: vi.fn(() => read()),
          eq: vi.fn(() => read()),
          maybeSingle: async () => ({
            data: adminRead.conversationRow,
            error: null,
          }),
        });
        return read();
      }
      if (table === 'messages') {
        // The service-role client serves the inbound-anchor lookups so the
        // send path is never blocked by RLS on `messages`.
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: () => builder,
          not: () => builder,
          order: () => builder,
          limit: async () => ({ data: adminRead.inboundRows, error: null }),
        };
        return builder;
      }
      if (table === 'contacts') {
        // The strict recipient override re-reads the full contact row with the
        // service role; `adminRead.contactRow` can differ from the RLS-scoped
        // `conversation.contact` embed to simulate RLS hiding a phone. The
        // same client also persists recovered / auto-corrected numbers.
        const read = () => ({
          select: vi.fn(() => read()),
          eq: vi.fn(() => read()),
          single: async () => ({ data: adminRead.contactRow, error: null }),
          update: (value: Record<string, unknown>) => {
            if (value && typeof value.phone === 'string') {
              adminRead.persistedPhones.push(value.phone);
            }
            return {
              eq: async () => ({ error: null }),
            };
          },
        });
        return read();
      }
      // Best-effort "pause active flow run" write.
      return {
        update: () => ({
          eq: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
        }),
      };
    },
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
    /** Extra conversation fields (e.g. `wa_id`) the cascade may resolve from. */
    conversation?: Record<string, unknown>;
    /** Row returned when the send resolves an explicit `reply_to_message_id`. */
    replyParent?: { message_id?: string | null };
  }
): SupabaseClient {
  const conversation = {
    id: 'cv-1',
    contact: opts?.contact ?? { id: 'ct-1', phone: '+15551234567' },
    ...(opts?.conversation ?? {}),
  };
  const config = {
    id: 'cfg-1',
    phone_number_id: 'pn-1',
    access_token: 'token',
  };
  // Inbound rows returned by the anchor lookup. `latestInboundAnchorId` reads
  // the newest customer wamid so a send to an opaque-id contact can be quoted.
  // The lookup runs with the service-role client (`adminRead`); the sibling
  // `inboundRows` below keeps the user-scoped fake's own `limit` honest.
  const inboundRows = opts?.inboundRows ?? [];
  // The 24h customer-service window is measured from the newest inbound
  // `created_at`. A test that omits it still exercises an OPEN window, so the
  // existing BSUID/anchor coverage is unaffected; a test that wants the
  // window closed passes an explicit `created_at` 24h+ in the past.
  adminRead.inboundRows = inboundRows.map((row) => ({
    created_at: new Date().toISOString(),
    ...(row as Record<string, unknown>),
  }));
  // Mirror the contact into the service-role read; a test may then override
  // this with a row that RLS WOULD have hidden (see the strict-override test).
  adminRead.contactRow = (opts?.contact ?? {
    id: 'ct-1',
    phone: '+15551234567',
  }) as Record<string, unknown>;
  // Mirror the conversation embed into the service-role read the cascade uses.
  adminRead.conversationRow = {
    id: 'cv-1',
    contact: opts?.contact ?? { id: 'ct-1', phone: '+15551234567' },
    ...(opts?.conversation ?? {}),
  };

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
    phone: 'CO.9988776655443322',
    wa_user_id: '9988776655443322',
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
      expect.objectContaining({ to: '9988776655443322' })
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

  it('refuses a free-form BSUID send when the 24h window is closed (no inbound at all)', async () => {
    // A privacy-redacted lead with NO inbound ever has no 24h window: the
    // reply would have nothing to quote, so Meta would drop it. The gate
    // answers 422 `bsuid_window_closed` BEFORE any HTTP request, with the
    // exact warning the UI must display.
    const err = await sendMessageToConversation(
      sendPathDb([], {}, { contact: OPAQUE_CONTACT, inboundRows: [] }),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'text',
        contentText: 'Hola',
      }
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SendMessageError);
    const sendError = err as SendMessageError;
    expect(sendError.status).toBe(422);
    expect(sendError.code).toBe('bsuid_window_closed');
    expect(sendError.message).toBe(
      'Ventana de atención de 24 horas cerrada para este contacto. Para iniciar conversación con un número protegido por Meta se requiere enviar una Plantilla (Template).'
    );
    expect(sendError.windowClosed).toBe(true);
    expect(sendError.howToFix).toBeTruthy();
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it('refuses a free-form BSUID send when the newest inbound is older than 24h', async () => {
    const twentyFiveHoursAgo = new Date(
      Date.now() - 25 * 60 * 60 * 1000
    ).toISOString();
    const err = await sendMessageToConversation(
      sendPathDb([], {}, {
        contact: OPAQUE_CONTACT,
        inboundRows: [
          { message_id: 'wamid.STALE', created_at: twentyFiveHoursAgo },
        ],
      }),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'text',
        contentText: 'Hola',
      }
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SendMessageError);
    expect((err as SendMessageError).code).toBe('bsuid_window_closed');
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it('sends a BSUID free-form message while the window stays open', async () => {
    // A lead who wrote within the last 24h can be answered even with no
    // inbound wamid to quote: the numeric BSUID goes cold in `to`.
    const outcome = await sendMessageToConversation(
      sendPathDb([], {}, {
        contact: OPAQUE_CONTACT,
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
    expect(outcome).toBeDefined();
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '9988776655443322',
        contextMessageId: 'wamid.INBOUND',
      })
    );
  });

  it('lets a template reach a BSUID contact even with the window closed', async () => {
    // Templates are Meta's out-of-window channel: they must not be hostage
    // to the 24h window like free-form text/media/interactive are.
    await sendMessageToConversation(
      sendPathDb([], {}, { contact: OPAQUE_CONTACT, inboundRows: [] }),
      'acct-1',
      {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'order_update',
        templateParams: ['A123', 'Friday'],
      }
    );

    expect(sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: '9988776655443322' })
    );
  });

  it('leaves a dialable phone untouched by the window gate even with no inbound', async () => {
    // The gate is strictly for BSUID / privacy-redacted ids: a real number
    // is addressed cold regardless of the 24h window.
    await sendMessageToConversation(
      sendPathDb([], {}, {
        contact: { id: 'ct-1', phone: '+15551234567' },
        inboundRows: [],
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
// STRICT RECIPIENT OVERRIDE. Whatever the caller claims (a BSUID, an
// @user) or whatever an RLS-scoped read returns (a contact row whose
// `phone` is trimmed away), the send core re-reads the full contacts row
// with the service role and forces the destination from the DB.
// ============================================================
describe('sendMessageToConversation - strict service-role contact override', () => {
  it('sends DIRECTLY to the service-role phone even when the RLS embed hides it', async () => {
    // The embed (RLS-scoped) exposes a phone-less contact; the service-role
    // read carries the decorated real number. The override must clean it and
    // aim the payload at the bare digits — never at a BSUID or @user.
    const db = sendPathDb(
      [],
      {},
      { contact: { id: 'ct-1', phone: null } }
    );
    adminRead.contactRow = {
      id: 'ct-1',
      phone: '@573044556788',
      wa_user_id: '9988776655443322',
      username: '@alias_demo',
    };

    await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'Hola Cliente',
    });

    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: '573044556788' })
    );
    const call = vi.mocked(sendTextMessage).mock.calls[0][0] as {
      to: string;
      contextMessageId?: string;
    };
    expect(call.to).not.toMatch(/@alias_demo|9988776655443322/);
    expect(call.contextMessageId).toBeUndefined();
  });

  it('falls back to the embed when the service-role read is unavailable', async () => {
    // A service-role client that cannot serve `contacts` (unconfigured at
    // runtime, tests, partial mocks) must degrade to the RLS embed instead of
    // crashing the send.
    const db = sendPathDb(
      [],
      {},
      { contact: { id: 'ct-1', phone: '+15551234567' } }
    );
    adminRead.contactRow = null;

    await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'Hola',
    });

    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: '15551234567' })
    );
  });
});

// ============================================================
// TAREA 1 — auto-persistencia del teléfono que viene en el payload.
// El editor de la interfaz puede NO haber guardado el número: si el payload
// trae un `phone` válido y `contacts.phone` está vacío/no usable, el core
// debe persistirlo con la service role y enviar directo (CAMINO A, sin
// `context`), dejando la BD corregida permanentemente.
// ============================================================
describe('sendMessageToConversation - TAREA 1: payload phone auto-persists via service role', () => {
  it('persists a payload phone and sends DIRECTLY to it without context', async () => {
    adminRead.persistedPhones = [];
    // Neither the embed nor the service-role row carry a usable number:
    // `phone` holds the @user. The caller still hands us the real number.
    adminRead.contactRow = {
      id: 'ct-1',
      phone: '@alias_demo',
      wa_user_id: '9988776655443322',
      username: '@alias_demo',
    };
    const db = sendPathDb(
      [],
      {},
      { contact: { id: 'ct-1', phone: null } }
    );

    await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'Hola Cliente',
      phone: '  +57 304 455 6788 ',
    });

    expect(adminRead.persistedPhones).toContain('573044556788');
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: '573044556788' })
    );
    const call = vi.mocked(sendTextMessage).mock.calls[0][0] as {
      to: string;
      contextMessageId?: string;
    };
    expect(call.to).not.toMatch(/@alias_demo|9988776655443322/);
    expect(call.contextMessageId).toBeUndefined();
  });

  it('does not overwrite a stored, dialable phone with the payload one', async () => {
    adminRead.persistedPhones = [];
    adminRead.contactRow = { id: 'ct-1', phone: '15551234567' };
    const db = sendPathDb(
      [],
      {},
      { contact: { id: 'ct-1', phone: '+15551234567' } }
    );

    await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'Hola',
      phone: '573044556788',
    });

    // The payload number must NOT win over the already-stored one: nothing
    // may write '573044556788' into `contacts.phone` nor aim the payload at it.
    expect(adminRead.persistedPhones).not.toContain('573044556788');
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    expect(sendTextMessage).toBeCalledWith(
      expect.objectContaining({ to: '15551234567' })
    );
  });
});

// ============================================================
// CASCADA DE DESTINATARIO — sin número en ninguna de las cinco fuentes, el
// core responde 422 `no_delivery_destination` con el `diagnostic_report`
// (valor por fuente) + `how_to_fix`, SIN gastar la llamada HTTP a Meta.
// ============================================================
describe('sendMessageToConversation - destination cascade 422 (no phone, no BSUID, no wamid)', () => {
  it('answers a structured 422 with diagnostic_report and how_to_fix and never calls Meta', async () => {
    adminRead.persistedPhones = [];
    const db = sendPathDb(
      [],
      {},
      {
        contact: {
          id: 'ct-1',
          phone: null,
          username: 'alias_demo',
        },
      }
    );

    const err = await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'Hola Cliente',
    }).catch((e: Error) => e);

    expect(err).toBeInstanceOf(SendMessageError);
    const sendError = err as SendMessageError;
    expect(sendError.status).toBe(422);
    expect(sendError.code).toBe('no_delivery_destination');
    // The definitive delivery-error string the CRM UI displays cleanly.
    expect(sendError.message).toBe('Error de entrega de mensaje');
    // The CRM-facing keys (Task 3B) plus the granular per-source detail.
    expect(sendError.diagnosticReport).toEqual({
      phone_db: '',
      bsuid: '',
      selected_target: '',
      contacts_phone: '',
      contacts_metadata: '',
      conversations_wa_id: '',
      channel_bsuid: '',
      latest_inbound_from: '',
    });
    expect(sendError.howToFix).toBe(HOW_TO_FIX_DESTINATION);
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    expect(sendTextMessage).not.toHaveBeenCalled();
  });
});

// ============================================================
// CASCADA: las fuentes conversacionales (3, 4, 5) que la resolución legada
// NUNCA consultaba (solo `contacts.phone`/BSUID) sí pueden destinar el envío.
// El primer VALIDO (>= 8 dígitos puros) gana, EN ORDEN ESTRICTO.
// ============================================================
describe('sendMessageToConversation - destination cascade (S3/S4/S5 conversational sources)', () => {
  it('resolves conversations.wa_id (S3) when the contact carries no usable number', async () => {
    const db = sendPathDb(
      [],
      {},
      {
        contact: { id: 'ct-1', phone: null },
        conversation: { wa_id: '573155667789' },
        inboundRows: [{ message_id: 'wamid.INBOUND' }],
      }
    );

    await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'Hola',
    });

    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: '573155667789' })
    );
  });

  it('resolves contacts.metadata phone (S2) ahead of older sources', async () => {
    const db = sendPathDb(
      [],
      {},
      {
        contact: {
          id: 'ct-1',
          phone: null,
          metadata: { phone: '573266778890' },
        },
      }
    );

    await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'Hola',
    });

    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: '573266778890' })
    );
  });

  it('reports (and sends to) the last inbound from (S5) when nothing else holds a number', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.map(String).join(' '));
    });
    try {
      adminRead.persistedPhones = [];
      const db = sendPathDb(
        [],
        {},
        {
          contact: { id: 'ct-1', phone: null },
          inboundRows: [{ sender_phone: '57345566778' }],
        }
      );

      await sendMessageToConversation(db, 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'text',
        contentText: 'Hola',
      });

      const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
      expect(sendTextMessage).toHaveBeenCalledWith(
        expect.objectContaining({ to: '57345566778' })
      );
      // S5 acts like a recovered number: the service role corrects the row.
      expect(adminRead.persistedPhones).toContain('57345566778');

      // The [INFORME_DIAGNOSTICO_DESTINATARIO] block is printed before Meta.
      expect(logs.join('\n')).toContain('[INFORME_DIAGNOSTICO_DESTINATARIO]');
      expect(logs.join('\n')).toContain(
        '- DESTINATARIO FINAL SELECCIONADO: "57345566778"'
      );
      // The conversation now carries no numeric id, so the BSUID/WA_ID line
      // reports INVALIDO while the phone-driven destination is still sent.
      expect(logs.join('\n')).toContain(
        '- Conversation BSUID/WA_ID: "" -> [INVALIDO]'
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('complies with strict priority: a valid contacts.phone (S1) beats a wamid stored on the conversation (S3)', async () => {
    const db = sendPathDb(
      [],
      {},
      {
        contact: { id: 'ct-1', phone: '+573044556788' },
        conversation: { wa_id: '573155667789' },
      }
    );

    await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'Hola',
    });

    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: '573044556788' })
    );
  });

  it('REFUSES a namespaced BSUID at the shared ladder (CASO C)', async () => {
    // `WAID.1234567` is a namespaced Meta id: identity data, never a
    // destination. Even with an inbound wamid available, the send is refused
    // locally (422) before Meta sees anything.
    const db = sendPathDb(
      [],
      {},
      {
        contact: {
          id: 'ct-1',
          phone: null,
          username: null,
          wa_id: 'WAID.1234567',
        },
        inboundRows: [{ message_id: 'wamid.INBOUND' }],
      }
    );

    const err = await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'Hola',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SendMessageError);
    expect((err as SendMessageError).code).toBe('no_delivery_destination');
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    expect(sendTextMessage).not.toHaveBeenCalled();
  });
});

// ============================================================
// REGLA 1 → REGLA 2 escalation. The phone wins the ladder (REGLA 1) and
// goes out unanchored; Meta rejects it, so the queue walks up to the
// BSUID. THAT escalated attempt is where (#131009) "Parameter value is
// not valid" used to bite: the phone-first resolution had decided no
// anchor was ever needed, so the opaque id went out cold. The anchor now
// follows the address.
// ============================================================
describe('sendMessageToConversation - phone rejected → escalated BSUID carries the anchor', () => {
  it('anchors the escalated opaque attempt to the newest inbound wamid', async () => {
    const { sendTextMessage } = await import('@/lib/whatsapp/meta-api');
    vi.mocked(sendTextMessage).mockImplementation(async (args) => {
      if (args.to === '9988776655443322') return { messageId: 'wamid.escalated' };
      throw new MetaApiError('Recipient phone number not in allowed list', {
        status: 400,
        code: 131030,
      });
    });

    try {
      const captured: CapturedWrites = {};
      const result = await sendMessageToConversation(
        sendPathDb([], captured, {
          contact: {
            id: 'ct-1',
            phone: '+15551234567',
            wa_id: '9988776655443322',
          },
          inboundRows: [{ message_id: 'wamid.INBOUND' }],
        }),
        'acct-1',
        {
          conversationId: 'cv-1',
          messageType: 'text',
          contentText: 'Hola',
        }
      );

      expect(result.whatsappMessageId).toBe('wamid.escalated');

      const calls = vi.mocked(sendTextMessage).mock.calls;
      // REGLA 1: the real number goes first, completely untouched — no anchor.
      const first = calls[0][0];
      expect(first.to).toBe('15551234567');
      expect(first.contextMessageId).toBeUndefined();
      // The escalated opaque id carries the thread's customer wamid.
      const escalated = calls.find((c) => c[0].to === '9988776655443322');
      expect(escalated).toBeDefined();
      expect(escalated![0].contextMessageId).toBe('wamid.INBOUND');
    } finally {
      vi.mocked(sendTextMessage).mockImplementation(async () => ({
        messageId: 'wamid.text',
      }));
    }
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
    phone: 'CO.9988776655443322',
    wa_user_id: '9988776655443322',
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
        to: '9988776655443322',
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
    // The definitive delivery-error string; the cause rides in meta_response.
    expect(err.message).toBe('Error de entrega de mensaje');
    expect(err.metaResponse).toMatch(/no destination is available/);
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
    expect(err.message).toBe('Error de entrega de mensaje');
    expect(err.metaResponse).toMatch(/not in allowed list/);
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
    expect(err.message).toBe('Error de entrega de mensaje');
    expect(err.metaResponse).toMatch(/Invalid file/);
  });

  it('keeps 502 for a genuine Meta outage (5xx / network)', async () => {
    const err = await captureSendError(
      new MetaApiError('Service unavailable', { status: 503 })
    );
    expect(err.status).toBe(502);
    expect(err.code).toBe('meta_error');
    expect(err.message).toBe('Error de entrega de mensaje');
    expect(err.metaResponse).toMatch(/Service unavailable/);
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

  it('honors autoArm:false (the one-shot Timer 2 nudge)', async () => {
    // The expiry-nudge dispatch opts out so its own row write (completed)
    // can never stack a second ACTIVE row for the same conversation — and
    // no fresh row spawns if the client replied at the exact moment of
    // expiry (the webhook already cancelled the due row).
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