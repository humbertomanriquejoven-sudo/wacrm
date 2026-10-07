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
  scheduleManualFollowUp: vi.fn(),
  scheduleResponseWaitTimer: vi.fn(),
  cancelResponseWaitTimers: vi.fn(),
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
  scheduleManualFollowUp: mocks.scheduleManualFollowUp,
  scheduleResponseWaitTimer: mocks.scheduleResponseWaitTimer,
  cancelResponseWaitTimers: mocks.cancelResponseWaitTimers,
}));

vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}));

import { GET, POST } from './route';

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
  // Timer 2 rows served by the mocked `response_wait_timers` reads.
  responseWait: null as Record<string, unknown> | null,
  waitLast: null as Record<string, unknown> | null,
  // When set, the FIRST wait-last read fails with a migration-065 style
  // "column does not exist" so we can assert the legacy retry.
  waitLastError: null as string | null,
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
    neq: (col: string, val: unknown) => {
      entry.filters[`neq:${col}`] = val;
      return chain;
    },
    order: () => chain,
    limit: () => chain,
    maybeSingle: () => {
      if (table === 'conversations' && op === 'select') {
        return Promise.resolve({ data: state.conversation, error: null });
      }
      if (table === 'response_wait_timers' && op === 'select') {
        // `.neq('status', 'active')` marks the one-shot OUTCOME read.
        if (entry.filters['neq:status'] === 'active') {
          if (state.waitLastError) {
            const message = state.waitLastError;
            state.waitLastError = null; // consumed → legacy retry succeeds
            return Promise.resolve({ data: null, error: { message } });
          }
          return Promise.resolve({ data: state.waitLast, error: null });
        }
        return Promise.resolve({ data: state.responseWait, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
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
  mocks.getCurrentAccount.mockResolvedValue({
    supabase: db,
    accountId: 'acc-1',
    userId: 'user-1',
  });
  mocks.supabaseAdmin.mockReturnValue(db);
  state.responseWait = null;
  state.waitLast = null;
  state.waitLastError = null;
  mocks.scheduleManualFollowUp.mockResolvedValue({
    scheduled: true,
    reason: 'scheduled',
    id: 'fu-1',
  });
  mocks.scheduleResponseWaitTimer.mockResolvedValue({
    scheduled: true,
    reason: 'scheduled',
    id: 'wait-1',
    expires_at: '2026-10-06T12:05:00.000Z',
  });
  mocks.cancelResponseWaitTimers.mockResolvedValue(undefined);
});

describe('POST /api/whatsapp/follow-ups — custom minutes', () => {
  it('schedules at exactly now + N minutes, inferred as the 10m stage', async () => {
    const res = await post({
      conversation_id: 'conv-1',
      action: 'schedule',
      delay_minutes: 7,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scheduled).toBe(true);
    expect(mocks.scheduleManualFollowUp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: 'conv-1',
        contactId: 'contact-1',
        accountId: 'acc-1',
        type: '10m',
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
    expect(mocks.scheduleManualFollowUp).toHaveBeenCalledWith(
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
    expect(mocks.scheduleManualFollowUp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ delayMs: 10080 * 60 * 1000 }),
    );
  });

  it('surfaces a false schedule result instead of pretending success', async () => {
    mocks.scheduleManualFollowUp.mockResolvedValue({
      scheduled: false,
      reason: 'error',
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

  it('refuses to schedule while the per-chat switch is OFF', async () => {
    state.conversation = {
      id: 'conv-1',
      account_id: 'acc-1',
      contact_id: 'contact-1',
      follow_up_enabled: false,
    };
    const res = await post({
      conversation_id: 'conv-1',
      action: 'schedule',
      delay_minutes: 5,
    });
    const body = await res.json();
    expect(body.scheduled).toBe(false);
    expect(body.reason).toBe('disabled');
    expect(mocks.scheduleManualFollowUp).not.toHaveBeenCalled();
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

describe('POST /api/whatsapp/follow-ups — Timer 2 (wait reply)', () => {
  it('wait_schedule arms the timer for EXACTLY the typed minutes', async () => {
    const res = await post({
      conversation_id: 'conv-1',
      action: 'wait_schedule',
      delay_minutes: 5,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scheduled).toBe(true);
    expect(mocks.scheduleResponseWaitTimer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: 'conv-1',
        contactId: 'contact-1',
        accountId: 'acc-1',
        delayMinutes: 5,
      }),
    );
  });

  it('wait_reset cancels the old countdown and re-arms from the box value', async () => {
    await post({
      conversation_id: 'conv-1',
      action: 'wait_reset',
      delay_minutes: 3,
    });
    expect(mocks.scheduleResponseWaitTimer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ delayMinutes: 3 }),
    );
  });

  it('clamps out-of-range values to the max', async () => {
    const res = await post({
      conversation_id: 'conv-1',
      action: 'wait_schedule',
      delay_minutes: 9999999,
    });
    expect(res.status).toBe(200);
    expect(mocks.scheduleResponseWaitTimer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ delayMinutes: 10080 }),
    );
  });

  it('rejects a missing or malformed delay_minutes', async () => {
    const res = await post({
      conversation_id: 'conv-1',
      action: 'wait_schedule',
    });
    expect(res.status).toBe(400);
    expect(mocks.scheduleResponseWaitTimer).not.toHaveBeenCalled();
  });

  it('wait_cancel cancels the active timer for the thread (reason: manual)', async () => {
    const res = await post({
      conversation_id: 'conv-1',
      action: 'wait_cancel',
    });
    expect(res.status).toBe(200);
    expect(mocks.cancelResponseWaitTimers).toHaveBeenCalledWith(
      expect.anything(),
      'conv-1',
      'manual',
    );
  });
});

function getConversationStatus() {
  return GET(
    new Request('http://test/api/whatsapp/follow-ups?conversation_id=conv-1'),
  );
}

describe('GET /api/whatsapp/follow-ups — one-shot outcome state', () => {
  it('returns the last terminal wait row (completed → "Acción ejecutada")', async () => {
    state.waitLast = {
      id: 'wait-9',
      conversation_id: 'conv-1',
      status: 'completed',
      delay_minutes: 2,
      cancelled_reason: null,
      updated_at: '2026-10-06T12:05:00.000Z',
    };
    const res = await getConversationStatus();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.response_wait).toBeNull();
    expect(body.response_wait_last).toMatchObject({
      id: 'wait-9',
      status: 'completed',
      delay_minutes: 2,
      cancelled_reason: null,
    });
  });

  it('flags a reply-cancelled wait ("Cliente respondió") via cancelled_reason', async () => {
    state.waitLast = {
      id: 'wait-7',
      conversation_id: 'conv-1',
      status: 'cancelled',
      delay_minutes: 5,
      cancelled_reason: 'inbound',
      updated_at: '2026-10-06T11:40:00.000Z',
    };
    const res = await getConversationStatus();
    const body = await res.json();
    expect(body.response_wait_last).toMatchObject({
      status: 'cancelled',
      cancelled_reason: 'inbound',
    });
  });

  it('degrades to a legacy outcome read when migration 065 is not applied', async () => {
    state.waitLast = {
      id: 'wait-5',
      conversation_id: 'conv-1',
      status: 'cancelled',
      delay_minutes: 3,
      updated_at: '2026-10-06T10:00:00.000Z',
    };
    state.waitLastError = 'column response_wait_timers.cancelled_reason does not exist';
    const res = await getConversationStatus();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.response_wait_last).toMatchObject({
      id: 'wait-5',
      status: 'cancelled',
      delay_minutes: 3,
    });
    expect(body.response_wait_last?.cancelled_reason).toBeUndefined();
  });

  it('keeps the active timer visible and the outcome empty while waiting', async () => {
    state.responseWait = {
      id: 'wait-1',
      conversation_id: 'conv-1',
      status: 'active',
      delay_minutes: 5,
      started_at: '2026-10-06T12:00:00.000Z',
      expires_at: '2026-10-06T12:05:00.000Z',
    };
    const res = await getConversationStatus();
    const body = await res.json();
    expect(body.response_wait).toMatchObject({ id: 'wait-1', status: 'active' });
    expect(body.response_wait_last).toBeNull();
  });
});
