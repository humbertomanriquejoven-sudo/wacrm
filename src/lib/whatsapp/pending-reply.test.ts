import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  clearParkedReply,
  flushPendingReplies,
  listPendingReplies,
} from '@/lib/whatsapp/pending-reply';

/**
 * The promise this module makes to a customer: a reply Meta rejected is
 * kept verbatim, and it is released the moment the contact has ANY
 * addressable identifier — a real number, a BSUID, or a handle — never
 * before, so nothing is sent to an address that cannot exist.
 */

// ---------------------------------------------------------------
// Chainable stub that records the UPDATE payloads, since the whole
// behaviour of parking is "these columns get set".
// ---------------------------------------------------------------
function makeDb(conversationRows: Array<Record<string, unknown>>) {
  const updates: Array<{ payload: Record<string, unknown>; filters: unknown[] }> = [];

  const db = {
    from: vi.fn(() => {
      const filters: unknown[] = [];
      const b: Record<string, unknown> = {};
      const chain = () => b;
      for (const m of ['eq', 'not', 'order', 'in']) b[m] = vi.fn(chain);
      b.select = vi.fn(chain);
      b.update = vi.fn((payload: Record<string, unknown>) => {
        updates.push({ payload, filters });
        return b;
      });
      b.limit = vi.fn(() => Promise.resolve({ data: conversationRows, error: null }));
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: conversationRows, error: null });
      return b;
    }),
  };

  return { db: db as never, updates };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('clearParkedReply', () => {
  it('drops the text and lowers the flag together', async () => {
    const { db, updates } = makeDb([]);
    await clearParkedReply(db, 'acct-1', 'conv-1');

    expect(updates[0].payload).toMatchObject({
      awaiting_valid_phone: false,
      pending_reply_text: null,
      pending_reply_at: null,
    });
  });
});

describe('listPendingReplies', () => {
  it('returns only the conversations still holding a reply', async () => {
    const { db } = makeDb([
      {
        id: 'conv-1',
        contact_id: 'contact-1',
        pending_reply_text: 'respuesta guardada',
        pending_reply_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'conv-2',
        contact_id: 'contact-1',
        // Flag set but text gone: a banner with nothing behind it. Must not
        // be offered for delivery.
        pending_reply_text: '   ',
        pending_reply_at: null,
      },
    ]);

    const pending = await listPendingReplies(db, 'acct-1', 'contact-1');
    expect(pending.map((c) => c.id)).toEqual(['conv-1']);
  });
});

describe('flushPendingReplies', () => {
  const CONVERSATIONS = [
    {
      id: 'conv-1',
      contact_id: 'contact-1',
      pending_reply_text: 'primera',
      pending_reply_at: null,
    },
    {
      id: 'conv-2',
      contact_id: 'contact-1',
      pending_reply_text: 'segunda',
      pending_reply_at: null,
    },
  ];

  it('does nothing at all when the contact has no address', async () => {
    const { db } = makeDb(CONVERSATIONS);
    const send = vi.fn();

    const result = await flushPendingReplies({
      db,
      accountId: 'acct-1',
      contactId: 'contact-1',
      recipient: {},
      send,
    });

    expect(result).toEqual({ sent: 0, failed: 0, conversations: [] });
    expect(send).not.toHaveBeenCalled();
  });

  it('flushes a parked reply when the contact only has a BSUID', async () => {
    // BSUIDs and handles are deliverable `to` values now: holding the
    // reply hostage for a real phone number would stall the customer.
    const { db } = makeDb(CONVERSATIONS)
    const send = vi.fn(async () => {})

    const result = await flushPendingReplies({
      db,
      accountId: 'acct-1',
      contactId: 'contact-1',
      recipient: { phone: 'CO.1008477715690681', wa_user_id: '1008477715690681' },
      send,
    })

    expect(result.sent).toBe(2)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('sends each parked reply verbatim and clears it', async () => {
    const { db, updates } = makeDb(CONVERSATIONS);
    const sent: Array<[string, string]> = [];
    const send = vi.fn(async (conversationId: string, text: string) => {
      sent.push([conversationId, text]);
    });

    const result = await flushPendingReplies({
      db,
      accountId: 'acct-1',
      contactId: 'contact-1',
      recipient: { phone: '573122182949' },
      send,
    });

    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
    // Sent as written — the model is never asked again.
    expect(sent.map((c) => c[1])).toEqual(['primera', 'segunda']);
    // Two clears, one per delivered conversation.
    expect(updates).toHaveLength(2);
    expect(updates[0].payload).toMatchObject({ awaiting_valid_phone: false });
  });

  it('keeps a failed reply parked so the next attempt can retry it', async () => {
    const { db, updates } = makeDb(CONVERSATIONS);
    const send = vi.fn(async (conversationId: string) => {
      if (conversationId === 'conv-1') throw new Error('still rejected');
    });

    const result = await flushPendingReplies({
      db,
      accountId: 'acct-1',
      contactId: 'contact-1',
      recipient: { phone: '573122182949' },
      send,
    });

    expect(result).toMatchObject({ sent: 1, failed: 1, conversations: ['conv-2'] });
    // Only the delivered one was cleared.
    expect(updates).toHaveLength(1);
  });

  it('delivers the other threads even when one of them fails', async () => {
    // A contact can hold several conversations. Losing all of them because
    // one row is bad would be worse than delivering what we can.
    const { db } = makeDb(CONVERSATIONS);
    const send = vi.fn(async (conversationId: string) => {
      if (conversationId === 'conv-1') throw new Error('boom');
    });

    const result = await flushPendingReplies({
      db,
      accountId: 'acct-1',
      contactId: 'contact-1',
      recipient: { phone: '573122182949' },
      send,
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(result.sent).toBe(1);
  });
});