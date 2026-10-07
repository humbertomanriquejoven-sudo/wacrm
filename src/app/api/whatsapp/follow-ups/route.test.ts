import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The inbox timer lets the agent type ANY number of minutes. These tests
 * pin the API contract: a custom `delay_minutes` becomes `delayMs` on the
 * schedule (with the stage inferred), manual actions bypass the automatic
 * kill switches (`force`), and turning the per-chat switch off clears the
 * queue.
 */

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
  scheduleFollowUp: vi.fn(),
  supabaseAdmin: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.getCurrentAccount,
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn((err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : 'error' },
      { status: 500 },
    ),
  ),
}));

vi.mock('@/lib/whatsapp/follow-up-worker', () => ({
  scheduleFollowUp: mocks.scheduleFollowUp,
}));

vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}));

import { POST } from './route';

interface Op {
  table: string;
  op: string;
  payload?: unknown;
  filters: Record<string, unknown>;
}

const state = {
  conversation: {
    id: 'conv-1',
    account_id: 'acc-1',
    contact_id: 'contact-1',
    follow_up_enabled: null,
  } as Record<string, unknown> | null,
  ops: [] as Op[],
};

function chainFor(table: string, op: string, payload?: unknown) {
  const entry: Op = { table, op, payload, filters: {} };
  state.ops.push(entry);
  const chain: Record<string, unknown> = {
    eq: (col: string, val: unknown) => {
      entry.filters[col] = val;
      return chain;
    },
    maybeSingle: () =>
      Promise.resolve(
        table === 'conversations' && op === 'select'
          ? { data: state.conversation, error: null }
          : { data: null, error: null },
      ),
    // Allows `await update(...).eq(...).eq(...)` without maybeSingle.
    then: (resolve: (value: unknown) => unknown) =>
      resolve({ data: null, error: null }),
  };
  return chain;
}

const db = {
  from: (table: string) => ({
    select: () => chainFor(table, 'select'),
    update: (payload: unknown) => chainFor(table, 'update', payload),
    insert: (payload: unknown) => chainFor(table, 'insert', payload),
  }),
};

function post(body: Record<string, unknown>) {
  return POST(
    new Request('http://test/api/whatsapp/follow-ups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.conversation = {
    id: 'conv-1',
    account_id: 'acc-1',
    contact_id: 'contact-1',
    follow_up_enabled: null,
  };
  state.ops.length = 0;
  mocks.requireRole.mockResolvedValue({
    supabase: db,
    accountId: 'acc-1',
    userId: 'user-1',
  });
  mocks.supabaseAdmin.mockReturnValue(db);
  mocks.scheduleFollowUp.mockResolvedValue({
    scheduled: true,
    reason: 'scheduled',
    id: 'fu-1',
  });
});

describe('POST /api/whatsapp/follow-ups — custom minutes', () => {
  it('schedules at now + N minutes, forced and inferred as the 10m stage', async () => {
    const res = await post({
      conversation_id: 'conv-1',
      action: 'schedule',
      delay_minutes: 7,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scheduled).toBe(true);
    expect(mocks.scheduleFollowUp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: 'conv-1',
        contactId: 'contact-1',
        accountId: 'acc-1',
        type: '10m',
        force: true,
        delayMs: 7 * 60 * 1000,
      }),
    );
  });

  it('treats ≥ 24 h as the 24h stage', async () => {
    await post({
      conversation_id: 'conv-1',
      action: 'schedule',
      delay_minutes: 24 * 60,
    });
    expect(mocks.scheduleFollowUp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: '24h', delayMs: 24 * 60 * 60 * 1000 }),
    );
  });

  it('clamps out-of-range values', async () => {
    await post({
      conversation_id: 'conv-1',
      action: 'schedule',
      delay_minutes: 999999,
    });
    expect(mocks.scheduleFollowUp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ delayMs: 10080 * 60 * 1000 }),
    );
  });

  it('surfaces a false schedule result instead of pretending success', async () => {
    mocks.scheduleFollowUp.mockResolvedValue({
      scheduled: false,
      reason: 'already_followed_up',
      id: null,
    });
    const res = await post({
      conversation_id: 'conv-1',
      action: 'schedule',
      delay_minutes: 5,
    });
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.scheduled).toBe(false);
  });
});

describe('POST /api/whatsapp/follow-ups — inline toggle', () => {
  it('clears the queue when the per-chat switch is turned off', async () => {
    const res = await post({
      conversation_id: 'conv-1',
      action: 'set_enabled',
      enabled: false,
    });
    expect(res.status).toBe(200);

    const convUpdate = state.ops.find(
      (o) => o.table === 'conversations' && o.op === 'update',
    );
    expect(convUpdate?.payload).toEqual({ follow_up_enabled: false });

    const cancel = state.ops.find(
      (o) =>
        o.table === 'follow_ups' &&
        o.op === 'update' &&
        (o.payload as { status?: string })?.status === 'cancelled',
    );
    expect(cancel).toBeDefined();
    expect(cancel?.filters).toMatchObject({
      conversation_id: 'conv-1',
      status: 'pending',
    });
  });

  it('does not touch the queue when the switch is turned on', async () => {
    await post({
      conversation_id: 'conv-1',
      action: 'set_enabled',
      enabled: true,
    });
    const cancel = state.ops.find(
      (o) =>
        o.table === 'follow_ups' &&
        o.op === 'update' &&
        (o.payload as { status?: string })?.status === 'cancelled',
    );
    expect(cancel).toBeUndefined();
  });
});
