import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// The creation endpoint no longer sends. It persists the campaign
// and hands the recipients to the same server-side pass "Retry failed"
// runs, so these tests are about that handoff and about what the endpoint
// promises - not about Meta, which is exercised in broadcast-core's tests.
// ============================================================

const persistBroadcast = vi.fn();
const dispatchBroadcastDelivery = vi.fn();
const adminClient = { tag: 'admin' };

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({
    supabase: { tag: 'scoped' },
    accountId: 'acct-1',
    userId: 'user-1',
  })),
  toErrorResponse: vi.fn(() => Response.json({ error: 'x' }, { status: 500 })),
}));

vi.mock('@/lib/whatsapp/broadcast-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/whatsapp/broadcast-core')>();
  return {
    ...actual,
    persistBroadcast: (...args: unknown[]) => persistBroadcast(...args),
  };
});

vi.mock('@/lib/whatsapp/broadcast-dispatch', () => ({
  dispatchBroadcastDelivery: (...args: unknown[]) =>
    dispatchBroadcastDelivery(...args),
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => adminClient,
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({ error: 'rate' }, { status: 429 }),
  RATE_LIMITS: { broadcast: 1 },
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: (fn: () => Promise<void>) => fn() };
});

import { POST } from '@/app/api/whatsapp/broadcast/route';

function post(body: unknown) {
  return POST(
    new Request('http://x/api/whatsapp/broadcast', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
}

const RECIPIENTS = [
  { contact_id: 'c1', params: ['a'] },
  { contact_id: 'c2', params: [] },
];

beforeEach(() => {
  vi.clearAllMocks();
  persistBroadcast.mockResolvedValue({
    broadcastId: 'bc-1',
    total: 2,
    duplicates: 0,
  });
  dispatchBroadcastDelivery.mockResolvedValue({
    broadcastId: 'bc-1',
    scope: 'pending',
    resuming: 2,
    remaining: 0,
    unsendable: 0,
  });
});

describe('POST /api/whatsapp/broadcast', () => {
  it('persists the campaign before dispatching anything', async () => {
    const order: string[] = [];
    persistBroadcast.mockImplementation(async () => {
      order.push('persist');
      return { broadcastId: 'bc-1', total: 2, duplicates: 0 };
    });
    dispatchBroadcastDelivery.mockImplementation(async () => {
      order.push('dispatch');
      return {
        broadcastId: 'bc-1',
        scope: 'pending',
        resuming: 2,
        remaining: 0,
        unsendable: 0,
      };
    });

    await post({
      template_name: 'order_update',
      recipients: RECIPIENTS,
    });

    // The planner must never read rows this request has not committed yet.
    expect(order).toEqual(['persist', 'dispatch']);
  });

  it('dispatches the pending scope with the service-role client', async () => {
    await post({ template_name: 'order_update', recipients: RECIPIENTS });

    const [scoped, admin, accountId, broadcastId, scope, run] =
      dispatchBroadcastDelivery.mock.calls[0];
    expect(scoped).toEqual({ tag: 'scoped' });
    // The fan-out outlives the request, so it cannot run on a session client.
    expect(admin).toBe(adminClient);
    expect(accountId).toBe('acct-1');
    expect(broadcastId).toBe('bc-1');
    expect(scope).toBe('pending');
    expect(typeof run).toBe('function');
  });

  it('keys recipients by contact_id, never by a phone number', async () => {
    await post({ template_name: 'order_update', recipients: RECIPIENTS });

    const params = persistBroadcast.mock.calls[0][3];
    expect(params.recipients).toEqual([
      { contactId: 'c1', params: ['a'] },
      { contactId: 'c2', params: [] },
    ]);
    // A hidden number has no valid `to` at all, which is why this is by id.
    expect(JSON.stringify(params.recipients)).not.toMatch(/\+\d{8,}/);
  });

  it('answers 202 with the ids the UI needs to poll', async () => {
    const res = await post({
      template_name: 'order_update',
      recipients: RECIPIENTS,
    });

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      broadcast_id: 'bc-1',
      total: 2,
      resuming: 2,
      unsendable: 0,
    });
  });

  it('reports a duplicate contact rather than messaging it twice', async () => {
    persistBroadcast.mockResolvedValue({
      broadcastId: 'bc-1',
      total: 1,
      duplicates: 1,
    });

    const res = await post({
      template_name: 'order_update',
      recipients: [
        { contact_id: 'c1' },
        { contact_id: 'c1' },
      ],
    });

    await expect(res.json()).resolves.toMatchObject({
      total: 1,
      duplicates: 1,
    });
  });

  it('answers 409 instead of starting a second fan-out', async () => {
    dispatchBroadcastDelivery.mockResolvedValue(null);

    const res = await post({
      template_name: 'order_update',
      recipients: RECIPIENTS,
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('already running'),
    });
  });

  it('surfaces a persistence failure instead of sending a partial campaign', async () => {
    const { BroadcastError } = await import('@/lib/whatsapp/broadcast-core');
    persistBroadcast.mockRejectedValue(
      new BroadcastError('bad_request', "'recipients' must be a non-empty array", 400)
    );

    const res = await post({ template_name: 'order_update', recipients: [] });

    expect(res.status).toBe(400);
    // Nothing was dispatched, so no recipient can be left half-sent.
    expect(dispatchBroadcastDelivery).not.toHaveBeenCalled();
  });

  it('requires a template name', async () => {
    const { BroadcastError } = await import('@/lib/whatsapp/broadcast-core');
    persistBroadcast.mockRejectedValue(
      new BroadcastError('bad_request', "'template_name' is required", 400)
    );

    const res = await post({ recipients: RECIPIENTS });

    expect(res.status).toBe(400);
    expect(dispatchBroadcastDelivery).not.toHaveBeenCalled();
  });
});
