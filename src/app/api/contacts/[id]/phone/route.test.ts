import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  findMergeableOrphan: vi.fn(),
  mergeContactInto: vi.fn(),
  flushPendingReplies: vi.fn(),
  sendMessageToConversation: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('@/lib/contacts/merge', () => ({
  findMergeableOrphan: mocks.findMergeableOrphan,
  mergeContactInto: mocks.mergeContactInto,
}));

vi.mock('@/lib/whatsapp/pending-reply', () => ({
  AWAITING_PHONE_NOTICE:
    'Esperando número de teléfono válido para enviar respuesta',
  flushPendingReplies: mocks.flushPendingReplies,
}));

vi.mock('@/lib/whatsapp/send-message', () => ({
  sendMessageToConversation: mocks.sendMessageToConversation,
}));

import { PATCH } from './route';

/**
 * This route is the only place a parked reply can be released, so the
 * tests are about ordering and refusals: the number must be validated and
 * stored first, and the deferred send must never run against an address
 * Meta has already rejected.
 */

// ---------------------------------------------------------------
// Supabase stub. `contacts` reads and writes are per-test canned; the
// `.update(...)` payload is captured so tests can assert what was saved.
// ---------------------------------------------------------------
let contactRow: Record<string, unknown> | null = null;
let contactUpdate: Record<string, unknown> | null = null;
let updateError: { message: string; code?: string } | null = null;

const CONTEXT = {
  supabase: {} as never,
  accountId: 'acct-1',
  userId: 'user-1',
  role: 'agent',
  account: { id: 'acct-1', name: 'Acme' },
};

function makeSupabase() {
  return {
    from: vi.fn((table: string) => {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      for (const m of ['select', 'eq', 'neq']) b[m] = vi.fn(chain);
      b.update = vi.fn((payload: Record<string, unknown>) => {
        contactUpdate = payload;
        const r = b;
        (r as { then?: unknown }).then = (
          resolve: (v: unknown) => unknown
        ) => resolve({ error: updateError });
        return b;
      });
      b.maybeSingle = vi.fn(() => Promise.resolve({ data: contactRow, error: null }));
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: contactRow, error: null });
      void table;
      return b;
    }),
  };
}

function request(body: unknown) {
  return new Request('http://localhost/api/contacts/contact-1/phone', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: 'contact-1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  contactRow = {
    id: 'contact-1',
    account_id: 'acct-1',
    phone: 'CO.1008477715690681',
    name: 'Ana Ruiz',
    username: null,
    wa_user_id: '1008477715690681',
  };
  contactUpdate = null;
  updateError = null;

  const supabase = makeSupabase();
  (CONTEXT as { supabase: unknown }).supabase = supabase;

  mocks.requireRole.mockResolvedValue(CONTEXT);
  mocks.findMergeableOrphan.mockResolvedValue(null);
  mocks.mergeContactInto.mockResolvedValue({
    merged: false,
    conversationsMoved: 0,
    messagesMoved: 0,
    fieldsAbsorbed: [],
  });
  mocks.flushPendingReplies.mockResolvedValue({
    sent: 1,
    failed: 0,
    conversations: ['conv-1'],
  });
  mocks.sendMessageToConversation.mockResolvedValue({ messageId: 'msg-1' });
});

describe('PATCH /api/contacts/[id]/phone', () => {
  it('requires the agent role', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    const res = await PATCH(request({ phone: '573122182949' }), params);
    expect(res.status).toBe(403);
  });

  it('rejects a missing phone', async () => {
    const res = await PATCH(request({}), params);
    expect(res.status).toBe(400);
    expect(contactUpdate).toBeNull();
  });

  it('rejects a value that is not a dialable number', async () => {
    // A BSUID is exactly what the contact already has; accepting it would
    // "save" the broken value and re-run the same failed send.
    const res = await PATCH(request({ phone: 'CO.1008477715690681' }), params);
    expect(res.status).toBe(400);
    expect(contactUpdate).toBeNull();
  });

  it('normalises the number to digits on save', async () => {
    const res = await PATCH(request({ phone: '+57 (312) 218-2949' }), params);
    expect(res.status).toBe(200);
    expect(contactUpdate).toMatchObject({ phone: '573122182949' });
    const body = await res.json();
    expect(body.phone).toBe('573122182949');
  });

  it('404s when the contact is not in the account', async () => {
    contactRow = null;
    const res = await PATCH(request({ phone: '573122182949' }), params);
    expect(res.status).toBe(404);
  });

  it('reports a duplicate number as a conflict, without flushing', async () => {
    updateError = { message: 'duplicate key', code: '23505' };
    const res = await PATCH(request({ phone: '573122182949' }), params);
    expect(res.status).toBe(409);
    // Nothing was delivered: the save failed, so the phone is unchanged
    // and sending anyway would target the old, rejected address.
    expect(mocks.flushPendingReplies).not.toHaveBeenCalled();
  });

  it('flushes the parked reply after a successful save', async () => {
    const res = await PATCH(request({ phone: '573122182949' }), params);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      changed: true,
      pending_replies_sent: 1,
      pending_conversations: ['conv-1'],
    });

    expect(mocks.flushPendingReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct-1',
        contactId: 'contact-1',
        recipient: expect.objectContaining({ phone: '573122182949' }),
      })
    );
  });

  it('sends each parked reply through the shared send core', async () => {
    await PATCH(request({ phone: '573122182949' }), params);

    const send = mocks.flushPendingReplies.mock.calls[0][0].send as (
      conversationId: string,
      text: string
    ) => Promise<void>;

    await send('conv-9', 'texto guardado');

    expect(mocks.sendMessageToConversation).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      expect.objectContaining({
        conversationId: 'conv-9',
        messageType: 'text',
        contentText: 'texto guardado',
      })
    );
  });

  it('still flushes when the number is unchanged, since the point is unblocking', async () => {
    // An operator re-saving the same number is a legitimate way to retry a
    // send that failed for a reason we have since fixed.
    contactRow = { ...(contactRow as Record<string, unknown>), phone: '573122182949' };
    const res = await PATCH(request({ phone: '+573122182949' }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changed).toBe(false);
    expect(mocks.flushPendingReplies).toHaveBeenCalled();
  });

  it('merges an orphan contact after saving the number', async () => {
    mocks.findMergeableOrphan.mockResolvedValue({
      id: 'contact-orphan',
      account_id: 'acct-1',
      phone: 'CO.1008477715690681',
      name: 'Ana Ruiz',
      username: null,
      wa_user_id: '1008477715690681',
    });
    mocks.mergeContactInto.mockResolvedValue({
      merged: true,
      conversationsMoved: 1,
      messagesMoved: 4,
      fieldsAbsorbed: ['wa_user_id'],
    });

    const res = await PATCH(request({ phone: '573122182949' }), params);
    expect(res.status).toBe(200);
    expect(mocks.mergeContactInto).toHaveBeenCalledWith(
      expect.anything(),
      { accountId: 'acct-1', survivorId: 'contact-1', orphanId: 'contact-orphan' }
    );
    const body = await res.json();
    expect(body.merged).toBe(true);
  });

  it('keeps a failed flush from failing the save', async () => {
    // The phone IS saved at that point. Answering 500 would make the UI
    // tell the operator the number was not recorded, and they would retype
    // a number that is already correct.
    mocks.flushPendingReplies.mockResolvedValue({
      sent: 0,
      failed: 1,
      conversations: [],
    });

    const res = await PATCH(request({ phone: '573122182949' }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, pending_replies_failed: 1 });
  });

  it('reports how many replies went out so the UI can say so', async () => {
    const res = await PATCH(request({ phone: '573122182949' }), params);
    const body = await res.json();
    expect(body.notice).toBe(
      'Esperando número de teléfono válido para enviar respuesta'
    );
  });
});