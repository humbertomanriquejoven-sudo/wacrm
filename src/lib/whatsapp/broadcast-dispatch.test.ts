import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// The dispatch pass is what creation and "Retry failed" both run.
// These tests pin the ordering that makes it safe: claim before plan, plan
// before 'sending', and the fan-out after the response - plus the guarantee
// that a second caller cannot start a parallel fan-out.
// ============================================================

const claimBroadcastDelivery = vi.fn();
const planBroadcastResume = vi.fn();
const releaseBroadcastDelivery = vi.fn();
const markBroadcastSending = vi.fn();
const deliverBroadcast = vi.fn();
const finalizeBroadcastStatus = vi.fn();

vi.mock('@/lib/whatsapp/broadcast-resume', () => ({
  claimBroadcastDelivery: (...a: unknown[]) => claimBroadcastDelivery(...a),
  planBroadcastResume: (...a: unknown[]) => planBroadcastResume(...a),
  releaseBroadcastDelivery: (...a: unknown[]) => releaseBroadcastDelivery(...a),
  markBroadcastSending: (...a: unknown[]) => markBroadcastSending(...a),
  RESUME_SCOPES: ['pending', 'failed', 'all'],
}));

vi.mock('@/lib/whatsapp/broadcast-core', () => ({
  deliverBroadcast: (...a: unknown[]) => deliverBroadcast(...a),
  finalizeBroadcastStatus: (...a: unknown[]) => finalizeBroadcastStatus(...a),
}));

import { dispatchBroadcastDelivery } from './broadcast-dispatch';

const scoped = { tag: 'scoped' } as unknown as SupabaseClient;
const admin = { tag: 'admin' } as unknown as SupabaseClient;

const PLAN = {
  broadcastId: 'bc-1',
  templateName: 'order_update',
  templateLanguage: 'en_US',
  phoneNumberId: 'pn-1',
  accessToken: 'tok',
  accountId: 'acct-1',
  templateRow: null,
  planned: [{ recipientRowId: 'r1' }],
  rejected: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  claimBroadcastDelivery.mockResolvedValue(true);
  planBroadcastResume.mockResolvedValue({
    plan: PLAN,
    remaining: 0,
    unsendable: 0,
  });
  releaseBroadcastDelivery.mockResolvedValue(undefined);
  markBroadcastSending.mockResolvedValue(undefined);
  deliverBroadcast.mockResolvedValue(undefined);
  finalizeBroadcastStatus.mockResolvedValue(undefined);
});

describe('dispatchBroadcastDelivery', () => {
  it('claims, plans, marks sending, then fans out', async () => {
    const order: string[] = [];
    claimBroadcastDelivery.mockImplementation(async () => {
      order.push('claim');
      return true;
    });
    planBroadcastResume.mockImplementation(async () => {
      order.push('plan');
      return { plan: PLAN, remaining: 0, unsendable: 0 };
    });
    markBroadcastSending.mockImplementation(async () => {
      order.push('mark');
    });
    deliverBroadcast.mockImplementation(async () => {
      order.push('deliver');
    });

    const tasks: Array<() => Promise<void>> = [];
    await dispatchBroadcastDelivery(scoped, admin, 'acct-1', 'bc-1', 'pending', (t) =>
      tasks.push(t)
    );

    // The campaign must not read as in-flight until its plan is real.
    expect(order).toEqual(['claim', 'plan', 'mark']);

    // The fan-out is deferred, so the caller can answer immediately.
    expect(order).not.toContain('deliver');
    await tasks[0]();
    expect(order).toEqual(['claim', 'plan', 'mark', 'deliver']);
  });

  it('hands the fan-out the service-role client, not the session one', async () => {
    const tasks: Array<() => Promise<void>> = [];
    await dispatchBroadcastDelivery(scoped, admin, 'acct-1', 'bc-1', 'pending', (t) =>
      tasks.push(t)
    );

    expect(deliverBroadcast).not.toHaveBeenCalled();
    await tasks[0]();
    // `after()` outlives the request; a session-scoped client would not.
    expect(deliverBroadcast).toHaveBeenCalledWith(admin, PLAN);
  });

  it('refuses a second pass while one holds the claim', async () => {
    claimBroadcastDelivery.mockResolvedValue(false);

    const run = vi.fn();
    const result = await dispatchBroadcastDelivery(
      scoped,
      admin,
      'acct-1',
      'bc-1',
      'failed',
      run
    );

    expect(result).toBeNull();
    // Nothing planned, nothing sent: a double click must not double-message.
    expect(planBroadcastResume).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('releases the claim when planning throws', async () => {
    planBroadcastResume.mockRejectedValue(new Error('template missing'));

    await expect(
      dispatchBroadcastDelivery(scoped, admin, 'acct-1', 'bc-1', 'pending', vi.fn())
    ).rejects.toThrow('template missing');

    // Otherwise the campaign is locked out until the staleness window expires.
    expect(releaseBroadcastDelivery).toHaveBeenCalledWith(scoped, 'bc-1');
  });

  it('settles the campaign and releases the claim when the fan-out throws', async () => {
    deliverBroadcast.mockRejectedValue(new Error('meta exploded'));

    const tasks: Array<() => Promise<void>> = [];
    await dispatchBroadcastDelivery(scoped, admin, 'acct-1', 'bc-1', 'pending', (t) =>
      tasks.push(t)
    );
    await tasks[0]();

    expect(finalizeBroadcastStatus).toHaveBeenCalledWith(admin, 'bc-1');
    expect(releaseBroadcastDelivery).toHaveBeenCalledWith(admin, 'bc-1');
  });

  it('reports the counts the UI polls for', async () => {
    planBroadcastResume.mockResolvedValue({
      plan: { ...PLAN, planned: [{ recipientRowId: 'r1' }, { recipientRowId: 'r2' }] },
      remaining: 7,
      unsendable: 3,
    });

    const result = await dispatchBroadcastDelivery(
      scoped,
      admin,
      'acct-1',
      'bc-1',
      'pending',
      vi.fn()
    );

    expect(result).toEqual({
      broadcastId: 'bc-1',
      scope: 'pending',
      resuming: 2,
      // > 0 means the pass hit its cap and the backlog needs another pass.
      remaining: 7,
      unsendable: 3,
    });
  });
});
